import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Chat: at any time on an active Ticket, the default profile opens fresh in a terminal on the Ticket's worktree,
// told the Ticket. Laisso keeps no row for it and nothing about the Ticket changes; a headless Session already
// working the branch keeps running, and the Chat's agent is told to read rather than edit.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: plan
    prompt: Draft a plan in PLAN.md.
    advance: false
    artifact: file PLAN.md
  - name: act
    prompt: Carry the plan out.
    artifact: file DONE.md
`;

async function laissoWithTicket(config: LaissoConfig = {}, repo: { default_profile?: string } = {}) {
  const started = await startLaissoWithRepos({ app: { pipeline: "gated", ...repo } }, config, { gated: PIPELINE });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "gated" }) });
  return { laisso: started.laisso, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (laisso: Laisso, id: string, lever: string) => laisso.api<TicketDetail>(`/api/tickets/${id}/${lever}`, { method: "POST", body: "{}" });
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const launcherText = (launcher: string | null) => readFileSync(launcher!, "utf8");

describe("Chat", () => {
  it("opens the default profile fresh beside a running headless Session, which keeps running, and keeps no row", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ hang: true });
    await checkNow(laisso);
    const headless = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.session?.running && t.session.mode === "headless" ? t : null; }, "the headless Session to run");
    expect(headless.chat).toEqual({ profile: "claude", alongside: "plan" });

    const after = await pull(laisso, ticket.id, "chat");
    expect(after.display.state).toBe("running");
    expect(after.sessions).toHaveLength(1);
    expect(after.session).toMatchObject({ id: headless.session!.id, running: true, mode: "headless" });

    const [window] = await laisso.terminals();
    expect(window!.launcher).toMatch(new RegExp(`/tickets/${ticket.id}/sessions/chat-[0-9a-f-]+\\.command$`));
    const text = launcherText(window!.launcher);
    expect(text).toContain(`cd '${ticket.worktree}'`);
    expect(text).toContain("exec 'claude' '--session-id'");
    expect(text).not.toContain("--resume");
    expect(text).toContain("A human opened this chat");
    expect(text).toContain("do not edit files, commit or push unless the human asks you to");
  });

  it("opens at a Start gate without releasing it, and says nothing of a running Session", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await laisso.runner.script({ stdout: claudeFixture("success.json"), files: { "PLAN.md": "the plan\n" } });
    await checkNow(laisso);
    const holding = await waitFor(async () => { const t = await detailOf(laisso, ticket.id); return t.display.state === "holding" ? t : null; }, "the gate");
    expect(holding.chat).toEqual({ profile: "claude", alongside: null });

    const after = await pull(laisso, ticket.id, "chat");
    expect(after.display.state).toBe("holding");
    expect(after.triggers).toEqual(holding.triggers);
    const [window] = await laisso.terminals();
    expect(launcherText(window!.launcher)).not.toContain("do not edit files");
    expect(await laisso.runner.calls()).toHaveLength(1);
  });

  it("opens under the repo's default_profile, in its human settings, whatever the Stage runs", async () => {
    const profiles = { "claude-opus": { runner: "claude" as const, model: "opus" }, "claude-sonnet": { runner: "claude" as const, model: "sonnet", human: { model: "fable" } } };
    const { laisso, ticket } = await laissoWithTicket({ profiles }, { default_profile: "claude-sonnet" });
    expect((await detailOf(laisso, ticket.id)).chat).toEqual({ profile: "claude-sonnet", alongside: null });
    await pull(laisso, ticket.id, "chat");
    const [window] = await laisso.terminals();
    expect(launcherText(window!.launcher)).toContain("'--model' 'fable'");
  });

  it("is not offered on an Abandoned Ticket, and refuses there", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    const abandoned = await pull(laisso, ticket.id, "abandon");
    expect(abandoned.chat).toBeNull();
    const refused = await laisso.api<Response>(`/api/tickets/${ticket.id}/chat`, { method: "POST", body: "{}", raw: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/is abandoned/);
    expect(await laisso.terminals()).toHaveLength(0);
  });
});
