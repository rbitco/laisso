import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { codexAdapter } from "../src/runner/codex.ts";
import type { RunRequest } from "../src/runner/adapter.ts";
import { runnerFixture } from "./harness.ts";

// Seam two: the Codex adapter as pure functions against output recorded from
// codex-cli 0.157.1, and findSession against its recorded thread table.

const fixture = (name: string) => runnerFixture("codex", name);
const fixturesHome = path.join(import.meta.dirname, "fixtures", "codex");

const request: RunRequest = {
  stage: "implement",
  prompt: "Do the work described by the Ticket.",
  skills: ["implement", "tdd"],
  context: { id: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z", reference: "APP-12", repo: "app", branch: "APP-12-add-dark-mode", title: "Add dark mode", body: "A toggle in settings." },
  cwd: "/tmp/lasso-fixture/worktree",
  mode: "headless",
  sessionId: "3e728ae2-8d99-42f3-a7ba-6066de05d169",
  limits: { wallTimeMs: 60_000, remainingSpendUsd: 4.5 },
  profile: { runner: "codex" },
};

describe("codex adapter command", () => {
  it("builds a headless codex exec with approvals never, workspace-write, JSON, the worktree, and skills as link-form mentions", () => {
    const cmd = codexAdapter.command(request);
    expect(cmd.argv.slice(0, 9)).toEqual(["codex", "-a", "never", "exec", "--json", "-C", "/tmp/lasso-fixture/worktree", "-s", "workspace-write"]);
    const skills = path.join(homedir(), ".agents", "skills");
    expect(cmd.argv.at(-1)).toBe(
      [
        `[$implement](${skills}/implement/SKILL.md)`,
        `[$tdd](${skills}/tdd/SKILL.md)`,
        "",
        "You are working Lasso Ticket 01J8ZK3M9Q4R5S6T7V8W9X0Y1Z (APP-12) in repo app on branch APP-12-add-dark-mode, Stage implement.",
        "Title: Add dark mode",
        "",
        "A toggle in settings.",
        "",
        "Do the work described by the Ticket.",
      ].join("\n"),
    );
    expect(cmd.argv).toHaveLength(10);
    expect(cmd.cwd).toBe(request.cwd);
    expect(cmd.env.LASSO_SESSION).toBe(request.sessionId);
    expect(cmd.stdin).toBeUndefined();
    // Codex has no budget flag: Lasso enforces every limit itself.
    expect(codexAdapter.honours).toEqual([]);
    expect(codexAdapter.sessionIds).toBe("runner");
  });

  it("takes the skills directory from the profile's skills_dir, its model under -m, and its args after", () => {
    const cmd = codexAdapter.command({ ...request, profile: { runner: "codex", skills_dir: "/repo/.agents/skills", model: "gpt-5-codex", args: ["-c", "x=1"] } });
    expect(cmd.argv.slice(9, 13)).toEqual(["-m", "gpt-5-codex", "-c", "x=1"]);
    expect(cmd.argv).toHaveLength(14);
    expect(cmd.argv.at(-1)!.startsWith("[$implement](/repo/.agents/skills/implement/SKILL.md)\n[$tdd](/repo/.agents/skills/tdd/SKILL.md)\n\n")).toBe(true);
  });

  it("gives the model once under -m in every form, and none without one", () => {
    const profile = { runner: "codex" as const, model: "gpt-5-codex" };
    const forms = [
      codexAdapter.command({ ...request, profile }),
      codexAdapter.command({ ...request, profile, resume: true, runnerSessionId: "t" }),
      codexAdapter.command({ ...request, profile, mode: "terminal" }),
      codexAdapter.command({ ...request, profile, mode: "terminal", resume: true, runnerSessionId: "t" }),
    ];
    for (const cmd of forms) expect(cmd.argv.filter((a) => a === "-m")).toHaveLength(1);
    expect(forms[3]!.argv).toEqual(["codex", "resume", "t", "-s", "workspace-write", "-m", "gpt-5-codex"]);
    expect(codexAdapter.command(request).argv).not.toContain("-m");
  });

  it("resumes a headless run through exec resume on the thread id Codex assigned, with the sandbox set top-level", () => {
    const cmd = codexAdapter.command({ ...request, resume: true, runnerSessionId: "01a0e17d-746e-7123-93ce-e3f3b05e8375" });
    expect(cmd.argv.slice(0, 9)).toEqual(["codex", "-a", "never", "-s", "workspace-write", "exec", "resume", "--json", "01a0e17d-746e-7123-93ce-e3f3b05e8375"]);
    expect(cmd.argv).not.toContain("-C");
    expect(cmd.cwd).toBe(request.cwd);
    expect(cmd.env.LASSO_SESSION).toBe(request.sessionId);
  });

  it("builds an interactive terminal command in the worktree with the prompt, and resumes by thread id", () => {
    const opened = codexAdapter.command({ ...request, mode: "terminal", name: "Lasso: APP-12 grill", skills: ["grilling"], prompt: null });
    expect(opened.argv.slice(0, 3)).toEqual(["codex", "-s", "workspace-write"]);
    expect(opened.argv.at(-1)!.startsWith("[$grilling](")).toBe(true);
    expect(opened.argv).not.toContain("exec");
    const resumed = codexAdapter.command({ ...request, mode: "terminal", resume: true, runnerSessionId: "01a0e17d-746e-7123-93ce-e3f3b05e8375", name: "Lasso: APP-12 grill" });
    expect(resumed.argv).toEqual(["codex", "resume", "01a0e17d-746e-7123-93ce-e3f3b05e8375", "-s", "workspace-write"]);
    // LASSO_SESSION always names Lasso's own row, whatever Codex calls the thread.
    expect(resumed.env.LASSO_SESSION).toBe(request.sessionId);
  });

  it("has no transcript path to promise before the thread exists", () => {
    expect(codexAdapter.transcriptPath(request)).toBeNull();
  });
});

describe("codex adapter parse", () => {
  it("reads a completed turn: the agent message, usage, and the thread id Codex assigned", () => {
    const outcome = codexAdapter.parse(fixture("success.jsonl"), request);
    expect(outcome).toEqual({
      status: "succeeded",
      sessionId: "01a0e18c-51ac-7eb2-a6c9-cea33285e2d4",
      finalMessage: "OK",
      usage: { input_tokens: 2051, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
      costUsd: null,
      transcriptPath: null,
    });
  });

  it("reads a failed turn as failed with Codex's error", () => {
    const outcome = codexAdapter.parse(fixture("failed.jsonl"), request);
    expect(outcome.status).toBe("failed");
    expect(outcome.sessionId).toBe("01a0e17c-c242-7e80-bd95-97b5c3f3fd48");
    expect(outcome.finalMessage).toMatch(/^unexpected status 401 Unauthorized/);
    expect(outcome.usage).toBeNull();
  });

  it("reads a stream killed mid-turn as interrupted with the thread id, and empty output as interrupted with none", () => {
    expect(codexAdapter.parse(fixture("killed.jsonl"), request)).toMatchObject({ status: "interrupted", sessionId: "01a0e17c-c242-7e80-bd95-97b5c3f3fd48", finalMessage: null });
    expect(codexAdapter.parse("", request)).toMatchObject({ status: "interrupted", sessionId: null });
  });
});

describe("codex adapter findSession", () => {
  const previous = process.env.CODEX_HOME;
  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });

  it("finds the newest thread Codex created in the worktree since the launch, in the thread table under CODEX_HOME", () => {
    process.env.CODEX_HOME = fixturesHome;
    const cwd = "/Users/matt/.claude/jobs/dcee61b2/tmp/codexprobe";
    // Two exec threads in that cwd: 06:10:44.934 and 06:11:30.545 UTC on 2026-09-27.
    expect(codexAdapter.findSession({ cwd, launchedAfter: new Date("2026-09-27T06:10:00Z") })).toBe("01a0e17d-746e-7123-93ce-e3f3b05e8375");
    expect(codexAdapter.findSession({ cwd, launchedAfter: new Date("2026-09-27T06:11:00Z") })).toBe("01a0e17d-746e-7123-93ce-e3f3b05e8375");
    expect(codexAdapter.findSession({ cwd, launchedAfter: new Date("2026-09-27T06:12:00Z") })).toBeNull();
    expect(codexAdapter.findSession({ cwd: `${cwd}/work`, launchedAfter: new Date("2026-09-27T06:12:00Z") })).toBe("01a0e18c-51ac-7eb2-a6c9-cea33285e2d4");
    expect(codexAdapter.findSession({ cwd: "/somewhere/else", launchedAfter: new Date(0) })).toBeNull();
  });

  it("finds nothing when Codex has no thread table yet", () => {
    process.env.CODEX_HOME = path.join(fixturesHome, "missing");
    expect(codexAdapter.findSession({ cwd: "/x", launchedAfter: new Date(0) })).toBeNull();
  });
});
