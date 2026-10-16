import { describe, it, expect } from "vitest";
import { claudeAdapter } from "../src/runner/claude.ts";
import { codexAdapter } from "../src/runner/codex.ts";
import { piAdapter } from "../src/runner/pi.ts";
import type { RunnerAdapter } from "../src/runner/adapter.ts";
import { LatestMessageTracker } from "../src/session/latest-message.ts";
import { runnerFixture } from "./harness.ts";

// The Latest Message as stdout streams (LASSO-153, LASSO-155): the tracker splits chunks into lines, and each adapter
// says which lines hold the agent's words. The Claude fixture is shaped on stream-json from claude 2.1.283, with a
// subagent turn, thinking, tool calls, and a result record whose text is not a message. Codex and Pi are read from
// their recorded fixtures, and from longer runs built on the same shapes.
const CLAUDE = runnerFixture("claude", "messages.jsonl");
const LAST = "Dark mode is in: the toggle saves to settings, and tests pass. 日本語も大丈夫。";

/** Feeds `stdout` in chunks of the given byte sizes, cycling, and collects every change the tracker reports. */
function stream(stdout: string, sizes: number[], adapter: RunnerAdapter = claudeAdapter): { changes: string[]; tracker: LatestMessageTracker } {
  const tracker = new LatestMessageTracker((line) => adapter.message(line));
  const bytes = Buffer.from(stdout, "utf8");
  const changes: string[] = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length]!;
    const changed = tracker.feed(bytes.subarray(at, at + size));
    if (changed !== null) changes.push(changed);
    at += size;
  }
  const flushed = tracker.flush();
  if (flushed !== null) changes.push(flushed);
  return { changes, tracker };
}

describe("the Claude Code message rule", () => {
  it("reads the main agent's text blocks, joined, and nothing else", () => {
    const words = CLAUDE.split("\n").map((line) => claudeAdapter.message(line));
    expect(words.filter((w) => w !== null)).toEqual([
      "I'll start by reading the config loader — it's where dark mode is set. ✓",
      "Found it in src/theme.ts.\n\nAdding the dark palette now.",
      LAST,
    ]);
  });

  it("skips thinking, tool calls, a subagent's turn, results, and lines that are not JSON", () => {
    expect(claudeAdapter.message('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]},"parent_tool_use_id":null}')).toBeNull();
    expect(claudeAdapter.message('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]},"parent_tool_use_id":null}')).toBeNull();
    expect(claudeAdapter.message('{"type":"assistant","message":{"content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"toolu_1"}')).toBeNull();
    expect(claudeAdapter.message('{"type":"assistant","message":{"content":[{"type":"text","text":"   "}]},"parent_tool_use_id":null}')).toBeNull();
    expect(claudeAdapter.message('{"type":"result","subtype":"success","result":"done"}')).toBeNull();
    expect(claudeAdapter.message('{"type":"assistant", not json')).toBeNull();
    expect(claudeAdapter.message("plain text")).toBeNull();
  });
});

const line = (record: unknown) => JSON.stringify(record);

describe("the Codex message rule", () => {
  it("reads a completed agent_message from the recorded run, and not an error item", () => {
    expect(stream(runnerFixture("codex", "success.jsonl"), [7], codexAdapter).changes).toEqual(["OK"]);
  });

  it("follows each agent message of a longer run, skipping reasoning, commands and items still in progress", () => {
    const run = [
      line({ type: "thread.started", thread_id: "01a0e18c-51ac-7eb2-a6c9-cea33285e2d4" }),
      line({ type: "turn.started" }),
      line({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Thinking about the theme." } }),
      line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Looking for the theme code." } }),
      line({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "rg theme", status: "in_progress" } }),
      line({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "rg theme", aggregated_output: "src/theme.ts", exit_code: 0, status: "completed" } }),
      line({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Dark mode is in — tests pass." } }),
      line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");
    expect(stream(run, [1], codexAdapter).changes).toEqual(["Looking for the theme code.", "Dark mode is in — tests pass."]);
    expect(codexAdapter.message(line({ type: "item.completed", item: { type: "agent_message", text: "  " } }))).toBeNull();
  });
});

describe("the Pi message rule", () => {
  it("reads the assistant's message_end from the recorded run, without its thinking or the user's prompt", () => {
    expect(stream(runnerFixture("pi", "success.jsonl"), [64], piAdapter).changes).toEqual(["OK"]);
  });

  it("follows each assistant message of a longer run, passing over message_update lines", () => {
    const assistant = (content: unknown[], stopReason: string) => ({ role: "assistant", content, stopReason });
    const run = [
      line({ type: "session", version: 3, id: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab", timestamp: "2026-09-27T06:10:00.000Z" }),
      line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Add dark mode" }] } }),
      line({ type: "message_update", message: assistant([{ type: "text", text: "Looking" }], "stop") }),
      line({ type: "message_end", message: assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking for the theme." }, { type: "toolCall", name: "bash" }], "toolUse") }),
      line({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "src/theme.ts" }] } }),
      line({ type: "message_end", message: assistant([{ type: "text", text: "Dark mode is in." }], "stop") }),
      line({ type: "agent_end", messages: [] }),
    ].join("\n");
    expect(stream(run, [3, 11], piAdapter).changes).toEqual(["Looking for the theme.", "Dark mode is in."]);
    expect(piAdapter.message(line({ type: "message_update", message: assistant([{ type: "text", text: "Look" }], "stop") }))).toBeNull();
  });
});

describe("the Latest Message tracker", () => {
  it("reports each change once, whatever the chunk sizes, splitting lines and multi-byte characters", () => {
    const whole = stream(CLAUDE, [CLAUDE.length * 4]).changes;
    expect(whole).toEqual([LAST]);
    for (const sizes of [[1], [2], [3, 5, 7], [64], [1000, 1]]) {
      const { changes } = stream(CLAUDE, sizes);
      expect(changes.at(-1)).toBe(LAST);
      expect(new Set(changes).size).toBe(changes.length);
      expect(changes).toEqual(expect.arrayContaining([LAST]));
      expect(changes.every((c) => !c.includes("�"))).toBe(true);
    }
    // A byte at a time, every message is seen in order.
    expect(stream(CLAUDE, [1]).changes).toEqual(["I'll start by reading the config loader — it's where dark mode is set. ✓", "Found it in src/theme.ts.\n\nAdding the dark palette now.", LAST]);
  });

  it("holds a last line with no newline until it is flushed", () => {
    const line = CLAUDE.split("\n")[2]!;
    const tracker = new LatestMessageTracker((l) => claudeAdapter.message(l));
    expect(tracker.feed(line)).toBeNull();
    expect(tracker.flush()).toBe("I'll start by reading the config loader — it's where dark mode is set. ✓");
    expect(tracker.flush()).toBeNull();
  });

  it("reports nothing when a newer line repeats the Latest Message", () => {
    const tracker = new LatestMessageTracker((l) => l.trim() || null);
    expect(tracker.feed("one\n")).toBe("one");
    expect(tracker.feed("one\r\n")).toBeNull();
    expect(tracker.feed("\n\n")).toBeNull();
    expect(tracker.feed("two\n")).toBe("two");
  });
});
