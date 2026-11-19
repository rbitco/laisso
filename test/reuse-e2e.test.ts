import { describe, it, expect, afterEach } from "vitest";
import { startLaissoWithRepos, runCli, waitFor, type Laisso } from "./harness.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { IntakeResult, TicketDetail } from "../src/api/views.ts";

// Stage reuse end to end (LASSO-215): a Pipeline that copies a Stage runs it as its own, under the profile it sets.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const WORK = `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`;

describe("a Pipeline that uses another's Stage", () => {
  it("takes Intake and runs the copied Stage under the profile it overrides", async () => {
    const profiles = { "claude-opus": { runner: "claude" as const, model: "opus" }, "codex-gpt": { runner: "codex" as const, model: "gpt-5-codex" } };
    const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, { profiles, default_profile: "claude-opus" }, { work: WORK, "bug-fix": "stages:\n  - use: work.implement\n    profile: codex-gpt\n" });
    running.push(laisso);
    const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Fix the crash", repo: "app", pipeline: "bug-fix" }) });
    await laisso.api("/api/check-now", { method: "POST" });
    const [call] = await waitFor(async () => {
      const c = await laisso.runner.calls();
      return c.length ? c : null;
    }, "a Runner launch");
    expect(call!.argv[0]).toBe("codex");
    const detail = await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}`);
    expect(detail.sessions[0]!.profile!.name).toBe("codex-gpt");
  });
});

describe("a Pipeline kept as parts", () => {
  it("is never offered at Intake and is refused by name, while another Pipeline reuses it", async () => {
    const parts = "intake: false\nstages:\n  - name: review\n    prompt: Review it.\n";
    const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, {}, { work: WORK, parts, reviewed: "stages:\n  - use: work.implement\n  - use: parts.review\n" });
    running.push(laisso);
    const d = await laisso.api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input: "Add dark mode" }) });
    expect(d.pipeline.choices).toEqual(["default", "pr-review", "reviewed", "work"]);
    const r = await runCli(["add", "Add dark mode", "--yes", "--pipeline", "parts"], laisso);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("Pipeline parts is kept as parts (intake: false), so it takes no Tickets");
    const ok = await runCli(["add", "Add dark mode", "--yes", "--pipeline", "reviewed", "--json"], laisso);
    expect(ok.code).toBe(0);
  });
});

describe("a Pipeline that does not load", () => {
  it("is refused by laisso add with the loader's message", async () => {
    const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, {}, { work: WORK, "bug-fix": "stages:\n  - use: work.nope\n" });
    running.push(laisso);
    const r = await runCli(["add", "Fix it", "--yes", "--pipeline", "bug-fix"], laisso);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("Pipeline bug-fix stage 1 (use work.nope): work has no Stage named nope");
  });
});

describe("a Ticket on a Pipeline with copied Stages (LASSO-221)", () => {
  it("names each copied Stage's source from its Version, and keeps it after the source file is deleted", async () => {
    const { laisso } = await startLaissoWithRepos({ app: { pipeline: "work" } }, {}, { work: WORK, "bug-fix": "stages:\n  - name: triage\n    prompt: Triage it.\n  - use: work.implement\n" });
    running.push(laisso);
    const ticket = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Fix the crash", repo: "app", pipeline: "bug-fix" }) });
    const sources = async () => (await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}`)).stages.map((s) => [s.name, s.source ?? null]);
    expect(await sources()).toEqual([["triage", null], ["implement", "work"]]);
    await laisso.api("/api/pipelines/work?confirm=1", { method: "DELETE" });
    expect(await sources()).toEqual([["triage", null], ["implement", "work"]]);
  });
});
