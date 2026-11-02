import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { claudeAdapter } from "../src/runner/claude.ts";
import type { RunRequest } from "../src/runner/adapter.ts";
import { EFFORTS, PERMISSIONS, type ProfileConfig } from "../src/server/config.ts";
import { claudeFixture as fixture } from "./harness.ts";

// Seam two: the adapter as pure functions against output recorded from claude 2.1.283.

const request: RunRequest = {
  stage: "implement",
  prompt: "Do the work described by the Ticket.",
  skills: ["implement", "tdd"],
  context: { id: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z", reference: "APP-12", repo: "app", branch: "APP-12-add-dark-mode", title: "Add dark mode", body: "A toggle in settings.", prs: [] },
  cwd: "/tmp/laisso-fixture/worktree",
  mode: "headless",
  sessionId: "3e728ae2-8d99-42f3-a7ba-6066de05d169",
  limits: { wallTimeMs: 60_000, remainingSpendUsd: 4.5 },
  profile: { runner: "claude" },
};

/** The line every preamble carries, linked PRs or none. */
const LINKING =
  "If you open a PR on a branch other than APP-12-add-dark-mode, run `laisso pr link <url>` so Laisso tracks it as this Ticket's; for a PR you only read, add --referenced. `laisso pr list --json` shows the Ticket's PRs as they are now.";

describe("claude adapter command", () => {
  it("lists the Ticket's linked PRs in the preamble, leaving out what no read has seen, before the linking line", () => {
    const prs: RunRequest["context"]["prs"] = [
      { url: "https://github.com/owner/app/pull/7", role: "owned", title: "Add dark mode", head: "APP-12-add-dark-mode", base: "main" },
      { url: "https://github.com/owner/lib/pull/3", role: "referenced", title: null, head: null, base: "main" },
      { url: "https://github.com/owner/app/pull/9", role: "owned", title: "Theme tokens", head: null, base: null },
    ];
    const prompt = claudeAdapter.command({ ...request, context: { ...request.context, prs } }).argv[2]!;
    expect(prompt).toContain(
      [
        "A toggle in settings.",
        "",
        "Linked PRs:",
        '- owned: https://github.com/owner/app/pull/7 "Add dark mode" (head APP-12-add-dark-mode, base main)',
        "- referenced: https://github.com/owner/lib/pull/3 (base main)",
        '- owned: https://github.com/owner/app/pull/9 "Theme tokens"',
        "",
        LINKING,
        "",
        "Do the work described by the Ticket.",
      ].join("\n"),
    );
    // No new variable: the env is the same with links as without.
    expect(claudeAdapter.command({ ...request, context: { ...request.context, prs } }).env).toEqual(claudeAdapter.command(request).env);
  });

  it("builds a headless claude -p with skills as /name first, then the preamble, the baseline flags, and the chosen session id", () => {
    const cmd = claudeAdapter.command(request);
    expect(cmd.argv[0]).toBe("claude");
    expect(cmd.argv[1]).toBe("-p");
    expect(cmd.argv[2]).toBe(
      [
        "/implement",
        "/tdd",
        "",
        "You are working Laisso Ticket 01J8ZK3M9Q4R5S6T7V8W9X0Y1Z (APP-12) in repo app on branch APP-12-add-dark-mode, Stage implement.",
        "Title: Add dark mode",
        "",
        "A toggle in settings.",
        "",
        LINKING,
        "",
        "Do the work described by the Ticket.",
      ].join("\n"),
    );
    expect(cmd.argv.slice(3)).toEqual([
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "auto", "--permission-prompts", "none",
      "--session-id", "3e728ae2-8d99-42f3-a7ba-6066de05d169",
      "--max-budget-usd", "4.5",
    ]);
    expect(cmd.cwd).toBe("/tmp/laisso-fixture/worktree");
    expect(cmd.env).toEqual({
      LAISSO_TICKET: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z",
      LAISSO_REFERENCE: "APP-12",
      LAISSO_REPO: "app",
      LAISSO_BRANCH: "APP-12-add-dark-mode",
      LAISSO_STAGE: "implement",
      LAISSO_SESSION: "3e728ae2-8d99-42f3-a7ba-6066de05d169",
      LASSO_TICKET: "01J8ZK3M9Q4R5S6T7V8W9X0Y1Z",
      LASSO_REFERENCE: "APP-12",
      LASSO_REPO: "app",
      LASSO_BRANCH: "APP-12-add-dark-mode",
      LASSO_STAGE: "implement",
      LASSO_SESSION: "3e728ae2-8d99-42f3-a7ba-6066de05d169",
    });
    expect(cmd.stdin).toBeUndefined();
    expect(claudeAdapter.honours).toEqual(["remainingSpendUsd"]);
  });

  it("omits the spend flag without a limit, passes the profile's model and args through, and leaves an empty reference blank", () => {
    const cmd = claudeAdapter.command({ ...request, limits: {}, profile: { runner: "claude", model: "sonnet", args: ["--model", "claude-sonnet-5"] }, context: { ...request.context, reference: null, body: null } });
    expect(cmd.argv).not.toContain("--max-budget-usd");
    // The model flag comes first and the args after it, so an arg repeating it wins.
    expect(cmd.argv.slice(-4)).toEqual(["--model", "sonnet", "--model", "claude-sonnet-5"]);
    expect(cmd.argv[2]!.split("\n")[3]).toBe("You are working Laisso Ticket 01J8ZK3M9Q4R5S6T7V8W9X0Y1Z in repo app on branch APP-12-add-dark-mode, Stage implement.");
    expect(cmd.argv[2]).not.toContain("A toggle");
    expect(cmd.env.LAISSO_REFERENCE).toBe("");
  });

  it("builds an interactive terminal command on the same session id with a display name", () => {
    const cmd = claudeAdapter.command({ ...request, mode: "terminal", name: "Laisso: APP-12 Grill", skills: ["grilling"], prompt: null });
    expect(cmd.argv.slice(0, 7)).toEqual(["claude", "--session-id", request.sessionId, "--permission-mode", "acceptEdits", "--name", "Laisso: APP-12 Grill"]);
    expect(cmd.argv).toHaveLength(8);
    expect(cmd.argv.at(-1)!.startsWith("/grilling\n")).toBe(true);
    expect(cmd.argv).not.toContain("-p");
  });

  it("puts the profile's model under --model before its args, ahead of the prompt in a terminal and after the flags on resume", () => {
    const profile = { runner: "claude" as const, model: "opus", args: ["--verbose"] };
    const opened = claudeAdapter.command({ ...request, mode: "terminal", name: "Laisso: APP-12 Grill", profile });
    expect(opened.argv.slice(7, 10)).toEqual(["--model", "opus", "--verbose"]);
    expect(opened.argv).toHaveLength(11);
    const resumed = claudeAdapter.command({ ...request, mode: "terminal", resume: true, profile });
    expect(resumed.argv).toEqual(["claude", "--resume", request.sessionId, "--permission-mode", "acceptEdits", "--model", "opus", "--verbose"]);
  });

  it("names the transcript it will keep for a request", () => {
    expect(claudeAdapter.transcriptPath({ cwd: "/tmp/w t", sessionId: "abc" })).toMatch(/\/\.claude\/projects\/-tmp-w-t\/abc\.jsonl$/);
  });

  it("re-enters a held session id with --resume and no prompt", () => {
    const cmd = claudeAdapter.command({ ...request, mode: "terminal", resume: true, name: "Laisso: APP-12 grill" });
    expect(cmd.argv).toEqual(["claude", "--resume", request.sessionId, "--permission-mode", "acceptEdits"]);
    expect(cmd.env.LAISSO_SESSION).toBe(request.sessionId);
  });
});

describe("claude adapter effort and permission", () => {
  const sid = request.sessionId;
  /** Headless, headless resume, terminal and terminal resume under one profile, with the prompt elided. */
  const forms = (profile: ProfileConfig) =>
    [
      claudeAdapter.command({ ...request, profile }),
      claudeAdapter.command({ ...request, profile, resume: true }),
      claudeAdapter.command({ ...request, profile, mode: "terminal", name: "N" }),
      claudeAdapter.command({ ...request, profile, mode: "terminal", resume: true }),
    ].map((cmd) => cmd.argv.map((a) => (a.includes("\n") ? "<prompt>" : a)));
  const shapes = (headlessMode: string, terminalMode: string, extra: string[] = []) => [
    ["claude", "-p", "<prompt>", "--output-format", "stream-json", "--verbose", "--permission-mode", headlessMode, "--permission-prompts", "none", "--session-id", sid, "--max-budget-usd", "4.5", ...extra],
    ["claude", "-p", "<prompt>", "--output-format", "stream-json", "--verbose", "--permission-mode", headlessMode, "--permission-prompts", "none", "--resume", sid, "--max-budget-usd", "4.5", ...extra],
    ["claude", "--session-id", sid, "--permission-mode", terminalMode, "--name", "N", ...extra, "<prompt>"],
    ["claude", "--resume", sid, "--permission-mode", terminalMode, ...extra],
  ];

  it("keeps today's baseline in every form with effort and permission unset", () => {
    expect(forms({ runner: "claude" })).toEqual(shapes("auto", "acceptEdits"));
  });

  it.each(EFFORTS)("passes effort %s under --effort in every form, after the model and before the args", (effort) => {
    expect(forms({ runner: "claude", effort })).toEqual(shapes("auto", "acceptEdits", ["--effort", effort]));
    expect(forms({ runner: "claude", model: "opus", effort, args: ["--debug"] })).toEqual(shapes("auto", "acceptEdits", ["--model", "opus", "--effort", effort, "--debug"]));
  });

  const modes = { auto: "auto", edits: "acceptEdits", full: "bypassPermissions" } as const;
  it.each(PERMISSIONS)("replaces the baseline permission mode with %s's in every form, once, and keeps prompts off headless", (permission) => {
    const argvs = forms({ runner: "claude", permission });
    expect(argvs).toEqual(shapes(modes[permission], modes[permission]));
    for (const argv of argvs) expect(argv.filter((a) => a === "--permission-mode")).toHaveLength(1);
  });
});

describe("claude adapter parse", () => {
  const transcript = path.join(homedir(), ".claude", "projects", "-tmp-laisso-fixture-worktree");

  it("reads a success result: final message, cost, usage, session id, transcript pointer", () => {
    const outcome = claudeAdapter.parse(fixture("success.json"), request);
    expect(outcome).toMatchObject({
      status: "succeeded",
      sessionId: "3e728ae2-8d99-42f3-a7ba-6066de05d169",
      finalMessage: "OK",
      costUsd: 0.2936585,
      transcriptPath: path.join(transcript, "3e728ae2-8d99-42f3-a7ba-6066de05d169.jsonl"),
    });
    expect(outcome.usage).toMatchObject({ output_tokens: 4 });
  });

  it("reads max turns and max budget as exhausted with the Runner's reason", () => {
    expect(claudeAdapter.parse(fixture("max-turns.json"), request)).toMatchObject({
      status: "exhausted",
      sessionId: "b28a732e-e1e3-4113-a816-862d01b51961",
      finalMessage: "Reached maximum number of turns (1)",
      costUsd: 0.22838350000000002,
    });
    expect(claudeAdapter.parse(fixture("max-budget.json"), request)).toMatchObject({
      status: "exhausted",
      finalMessage: "Reached maximum budget ($0.001)",
    });
  });

  it("reads a result flagged is_error (here an unknown model) as failed with its message", () => {
    expect(claudeAdapter.parse(fixture("failed.jsonl"), request)).toMatchObject({
      status: "failed",
      sessionId: "c46af10d-b533-4185-ad59-81b8bb18114d",
      finalMessage: "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.",
      costUsd: 0,
    });
  });

  it("reads a stream killed mid-turn as interrupted, with the session id from the init record", () => {
    const outcome = claudeAdapter.parse(fixture("killed.jsonl"), request);
    expect(outcome).toEqual({
      status: "interrupted",
      sessionId: "6190d1d7-5d0b-46cd-a6ab-bb39a51570c7",
      finalMessage: null,
      usage: null,
      costUsd: null,
      transcriptPath: path.join(transcript, "6190d1d7-5d0b-46cd-a6ab-bb39a51570c7.jsonl"),
    });
  });

  it("reads empty output as interrupted on the requested id, and has no session to find", () => {
    expect(claudeAdapter.parse("", request)).toMatchObject({ status: "interrupted", sessionId: request.sessionId });
    expect(claudeAdapter.findSession({ cwd: request.cwd, launchedAfter: new Date() })).toBeNull();
  });
});
