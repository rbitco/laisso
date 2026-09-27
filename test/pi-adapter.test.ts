import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { piAdapter } from "../src/runner/pi.ts";
import type { RunRequest } from "../src/runner/adapter.ts";
import { runnerFixture } from "./harness.ts";

// Seam two: the Pi adapter as pure functions against output recorded from pi 0.85.1.

const fixture = (name: string) => runnerFixture("pi", name);

const request: RunRequest = {
  stage: "implement",
  prompt: "Do the work described by the Ticket.",
  skills: ["implement", "tdd"],
  context: { id: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z", reference: "APP-12", repo: "app", branch: "APP-12-add-dark-mode", title: "Add dark mode", body: "A toggle in settings." },
  cwd: "/Users/matt/.claude/jobs/dcee61b2/tmp/piprobe",
  mode: "headless",
  sessionId: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab",
  limits: { wallTimeMs: 60_000, remainingSpendUsd: 4.5 },
  runnerOptions: {},
};

const sessionsDir = path.join(homedir(), ".pi", "agent", "sessions", "--Users-matt-.claude-jobs-dcee61b2-tmp-piprobe--");

describe("pi adapter command", () => {
  it("builds a headless pi -p in JSON mode on the chosen session id with skills as /skill:name first", () => {
    const cmd = piAdapter.command(request);
    expect(cmd.argv.slice(0, 7)).toEqual(["pi", "-p", "--mode", "json", "--session-id", request.sessionId, "-a"]);
    expect(cmd.argv.at(-1)).toBe(
      [
        "/skill:implement",
        "/skill:tdd",
        "",
        "You are working Lasso Ticket 01J8ZK3M9Q4R5S6T7V8W9X0Y1Z (APP-12) in repo app on branch APP-12-add-dark-mode, Stage implement.",
        "Title: Add dark mode",
        "",
        "A toggle in settings.",
        "",
        "Do the work described by the Ticket.",
      ].join("\n"),
    );
    expect(cmd.argv).toHaveLength(8);
    expect(cmd.cwd).toBe(request.cwd);
    expect(cmd.env.LASSO_SESSION).toBe(request.sessionId);
    expect(cmd.stdin).toBeUndefined();
    // Pi has no budget flags: Lasso enforces every limit itself.
    expect(piAdapter.honours).toEqual([]);
    expect(piAdapter.sessionIds).toBe("lasso");
  });

  it("passes runnerOptions.args through before the prompt", () => {
    const cmd = piAdapter.command({ ...request, runnerOptions: { args: ["--model", "openai/gpt-5"] } });
    expect(cmd.argv.slice(7, 9)).toEqual(["--model", "openai/gpt-5"]);
    expect(cmd.argv.at(-1)!.startsWith("/skill:implement\n")).toBe(true);
  });

  it("builds an interactive terminal command on the same session id with a display name", () => {
    const cmd = piAdapter.command({ ...request, mode: "terminal", name: "Lasso: APP-12 grill", skills: ["grilling"], prompt: null });
    expect(cmd.argv.slice(0, 6)).toEqual(["pi", "--session-id", request.sessionId, "-n", "Lasso: APP-12 grill", "-a"]);
    expect(cmd.argv.at(-1)!.startsWith("/skill:grilling\n")).toBe(true);
    expect(cmd.argv).not.toContain("-p");
  });

  it("re-enters a held session id with no prompt", () => {
    const cmd = piAdapter.command({ ...request, mode: "terminal", resume: true, name: "Lasso: APP-12 grill" });
    expect(cmd.argv).toEqual(["pi", "--session-id", request.sessionId, "-a"]);
  });

  it("points at the sessions directory Pi keeps for the worktree before the run names its file", () => {
    expect(piAdapter.transcriptPath(request)).toBe(sessionsDir);
    expect(piAdapter.transcriptPath({ cwd: "/tmp/w t", sessionId: "abc" })).toMatch(/\/\.pi\/agent\/sessions\/--tmp-w t--$/);
  });
});

describe("pi adapter parse", () => {
  it("reads a success: final text, usage with cost, the session id from the header, and the exact transcript file", () => {
    const outcome = piAdapter.parse(fixture("success.jsonl"), request);
    expect(outcome).toMatchObject({
      status: "succeeded",
      sessionId: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab",
      finalMessage: "OK",
      costUsd: 0,
      transcriptPath: path.join(sessionsDir, "2026-09-27T06-09-58-627Z_7d3f2c10-5b1e-4a8c-9e2f-1234567890ab.jsonl"),
    });
    expect(outcome.usage).toMatchObject({ input: 951, output: 20, totalTokens: 971 });
  });

  it("reads a message that stopped with an error as failed with Pi's message", () => {
    const outcome = piAdapter.parse(fixture("failed.jsonl"), request);
    expect(outcome.status).toBe("failed");
    expect(outcome.sessionId).toBe("8e4a3d21-6c2f-4b9d-af30-abcdef123456");
    expect(outcome.finalMessage).toMatch(/^OpenAI API error \(401\)/);
    expect(outcome.transcriptPath).toBe(path.join(sessionsDir, "2026-09-27T06-10-14-607Z_8e4a3d21-6c2f-4b9d-af30-abcdef123456.jsonl"));
  });

  it("reads a stream killed mid-turn as interrupted on the header's id", () => {
    expect(piAdapter.parse(fixture("killed.jsonl"), request)).toEqual({
      status: "interrupted",
      sessionId: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab",
      finalMessage: null,
      usage: null,
      costUsd: null,
      transcriptPath: path.join(sessionsDir, "2026-09-27T06-09-58-627Z_7d3f2c10-5b1e-4a8c-9e2f-1234567890ab.jsonl"),
    });
  });

  it("reads a final message with no agent_end after it as interrupted: the loop was cut off", () => {
    const cut = fixture("success.jsonl").split("\n").slice(0, 28).join("\n");
    expect(piAdapter.parse(cut, request)).toMatchObject({ status: "interrupted", sessionId: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab", finalMessage: null });
  });

  it("reads empty output as interrupted on the requested id, and has no session to find", () => {
    expect(piAdapter.parse("", request)).toMatchObject({ status: "interrupted", sessionId: request.sessionId, transcriptPath: sessionsDir });
    expect(piAdapter.findSession({ cwd: request.cwd, launchedAfter: new Date() })).toBeNull();
  });
});
