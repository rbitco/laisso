import { describe, it, expect, afterEach } from "vitest";
import { startLaissoWithRepos, waitFor, type Laisso } from "./harness.ts";
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
