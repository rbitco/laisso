import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { piAdapter } from "../src/runner/pi.ts";
import type { RunRequest } from "../src/runner/adapter.ts";
import { EFFORTS, PERMISSIONS, type ProfileConfig } from "../src/server/config.ts";
import { runnerFixture } from "./harness.ts";

// Seam two: the Pi adapter as pure functions against output recorded from pi 0.85.1.

const fixture = (name: string) => runnerFixture("pi", name);

const request: RunRequest = {
  stage: "implement",
  prompt: "Do the work described by the Ticket.",
  skills: ["implement", "tdd"],
  context: { id: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z", reference: "APP-12", repo: "app", branch: "APP-12-add-dark-mode", title: "Add dark mode", body: "A toggle in settings.", prs: [] },
  cwd: "/Users/matt/.claude/jobs/dcee61b2/tmp/piprobe",
  mode: "headless",
  sessionId: "7d3f2c10-5b1e-4a8c-9e2f-1234567890ab",
  limits: { wallTimeMs: 60_000, remainingSpendUsd: 4.5 },
  profile: { runner: "pi" },
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
        "You are working Laisso Ticket 01J8ZK3M9Q4R5S6T7V8W9X0Y1Z (APP-12) in repo app on branch APP-12-add-dark-mode, Stage implement.",
        "Title: Add dark mode",
        "",
        "A toggle in settings.",
        "",
        "If you open a PR on a branch other than APP-12-add-dark-mode, run `laisso pr link <url>` so Laisso tracks it as this Ticket's; for a PR you only read, add --referenced. `laisso pr list --json` shows the Ticket's PRs as they are now.",
        "",
        "Do the work described by the Ticket.",
      ].join("\n"),
    );
    expect(cmd.argv).toHaveLength(8);
    expect(cmd.cwd).toBe(request.cwd);
    expect(cmd.env.LAISSO_SESSION).toBe(request.sessionId);
    expect(cmd.stdin).toBeUndefined();
    // Pi has no budget flags: Laisso enforces every limit itself.
    expect(piAdapter.honours).toEqual([]);
    expect(piAdapter.sessionIds).toBe("laisso");
  });

  it("passes the profile's model under --model and its args through before the prompt", () => {
    const cmd = piAdapter.command({ ...request, profile: { runner: "pi", model: "openai/gpt-5", args: ["--thinking", "high"] } });
    expect(cmd.argv.slice(7, 11)).toEqual(["--model", "openai/gpt-5", "--thinking", "high"]);
    expect(cmd.argv).toHaveLength(12);
    expect(cmd.argv.at(-1)!.startsWith("/skill:implement\n")).toBe(true);
  });

  it("resumes a headless run on the earlier Session's id while the new row keeps its own", () => {
    const cmd = piAdapter.command({ ...request, resume: true, runnerSessionId: "11111111-2222-4333-8444-555555555555" });
    expect(cmd.argv.slice(0, 6)).toEqual(["pi", "-p", "--mode", "json", "--session-id", "11111111-2222-4333-8444-555555555555"]);
    expect(cmd.env.LAISSO_SESSION).toBe(request.sessionId);
  });

  it("builds an interactive terminal command on the same session id with a display name", () => {
    const cmd = piAdapter.command({ ...request, mode: "terminal", name: "Laisso: APP-12 grill", skills: ["grilling"], prompt: null });
    expect(cmd.argv.slice(0, 6)).toEqual(["pi", "--session-id", request.sessionId, "-n", "Laisso: APP-12 grill", "-a"]);
    expect(cmd.argv.at(-1)!.startsWith("/skill:grilling\n")).toBe(true);
    expect(cmd.argv).not.toContain("-p");
  });

  it("re-enters a held session id with no prompt", () => {
    const cmd = piAdapter.command({ ...request, mode: "terminal", resume: true, name: "Laisso: APP-12 grill" });
    expect(cmd.argv).toEqual(["pi", "--session-id", request.sessionId, "-a"]);
  });

  it("points at the sessions directory Pi keeps for the worktree before the run names its file", () => {
    expect(piAdapter.transcriptPath(request)).toBe(sessionsDir);
    expect(piAdapter.transcriptPath({ cwd: "/tmp/w t", sessionId: "abc" })).toMatch(/\/\.pi\/agent\/sessions\/--tmp-w t--$/);
  });
});

describe("pi adapter effort and permission", () => {
  const sid = request.sessionId;
  /** Headless, headless resume, terminal and terminal resume under one profile, with the prompt elided. */
  const forms = (profile: ProfileConfig) =>
    [
      piAdapter.command({ ...request, profile }),
      piAdapter.command({ ...request, profile, resume: true }),
      piAdapter.command({ ...request, profile, mode: "terminal", name: "N" }),
      piAdapter.command({ ...request, profile, mode: "terminal", resume: true }),
    ].map((cmd) => cmd.argv.map((a) => (a.includes("\n") ? "<prompt>" : a)));
  const shapes = (extra: string[] = []) => [
    ["pi", "-p", "--mode", "json", "--session-id", sid, "-a", ...extra, "<prompt>"],
    ["pi", "-p", "--mode", "json", "--session-id", sid, "-a", ...extra, "<prompt>"],
    ["pi", "--session-id", sid, "-n", "N", "-a", ...extra, "<prompt>"],
    ["pi", "--session-id", sid, "-a", ...extra],
  ];

  it("keeps today's baseline in every form with effort and permission unset", () => {
    expect(forms({ runner: "pi" })).toEqual(shapes());
  });

  it.each(EFFORTS)("passes effort %s under --thinking in every form, after the model and before the args", (effort) => {
    expect(forms({ runner: "pi", effort })).toEqual(shapes(["--thinking", effort]));
    expect(forms({ runner: "pi", model: "openai/gpt-5", effort, args: ["--offline"] })).toEqual(shapes(["--model", "openai/gpt-5", "--thinking", effort, "--offline"]));
  });

  it.each(PERMISSIONS)("ignores permission %s: Pi has no approval layer, so every form is unchanged", (permission) => {
    expect(forms({ runner: "pi", permission })).toEqual(forms({ runner: "pi" }));
    expect(forms({ runner: "pi", effort: "high", permission })).toEqual(forms({ runner: "pi", effort: "high" }));
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
