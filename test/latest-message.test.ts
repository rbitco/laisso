import { describe, it, expect } from "vitest";
import { claudeAdapter } from "../src/runner/claude.ts";
import { LatestMessageTracker } from "../src/session/latest-message.ts";
import { runnerFixture } from "./harness.ts";

// The Latest Message as stdout streams (LASSO-153): the tracker splits chunks into lines, and each adapter says which
// lines hold the agent's words. The Claude fixture is shaped on stream-json from claude 2.1.283, with a subagent turn,
// thinking, tool calls, and a result record whose text is not a message.
const CLAUDE = runnerFixture("claude", "messages.jsonl");
const LAST = "Dark mode is in: the toggle saves to settings, and tests pass. 日本語も大丈夫。";

/** Feeds `stdout` in chunks of the given byte sizes, cycling, and collects every change the tracker reports. */
function stream(stdout: string, sizes: number[]): { changes: string[]; tracker: LatestMessageTracker } {
  const tracker = new LatestMessageTracker((line) => claudeAdapter.message(line));
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
