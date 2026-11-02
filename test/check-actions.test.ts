import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startLaissoWithRepos, waitFor, claudeFixture, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// A config Action as a Stage's Artifact (ADR 0014, LASSO-115): run once the
// Runner succeeds and on Mark done, judged by exit code.
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
    artifact:
      action: grep-file
      with: { file: CHANGELOG.md, pattern: dark }
  - name: ship
    prompt: Ship it.
    human: true
`;

// Exit 0 when the file has the pattern, 1 when it does not; the env it saw is kept beside it.
const GREP: LaissoConfig["actions"] = {
  "grep-file": {
    params: ["file", "pattern"],
    run: 'env | grep ^LAISSO_ | sort > ../check-env.txt; if grep -q "$LAISSO_PATTERN" "$LAISSO_FILE" 2>/dev/null; then echo "found $LAISSO_PATTERN"; else echo "no $LAISSO_PATTERN in $LAISSO_FILE"; exit 1; fi',
  },
};

async function laissoWithTicket(actions: LaissoConfig["actions"] = GREP, pipeline = PIPELINE) {
  const started = await startLaissoWithRepos({ app: { pipeline: "check" } }, { actions }, { check: pipeline });
  running.push(started.laisso);
  const ticket = await started.laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "check" }) });
  return { laisso: started.laisso, ticket };
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
/** The Runner's Session ended and Laisso has judged it: the Ticket moved on or Flagged. */
const judged = (laisso: Laisso, id: string) => waitFor(async () => {
  const d = await detailOf(laisso, id);
  return d.session && !d.session.running && (d.stage.name !== "implement" || d.flag) ? d : null;
}, "the Stage to be judged");

async function runImplement(laisso: Laisso, files: Record<string, string> = {}) {
  await laisso.runner.script({ stdout: claudeFixture("success.json"), files });
}

describe("a check Action artifact", () => {
  it("advances on exit 0, run in the worktree with the Ticket's variables and its params", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await runImplement(laisso, { "CHANGELOG.md": "Added dark mode\n" });
    await checkNow(laisso);
    const d = await judged(laisso, ticket.id);
    expect(d.flag).toBeNull();
    expect(d.stage.name).toBe("ship");
    // A check records no Session of its own.
    expect(d.sessions.map((s) => s.stage)).toEqual(["implement"]);
    const env = await readFile(path.join(d.worktree, "..", "check-env.txt"), "utf8");
    expect(env).toContain(`LAISSO_TICKET=${ticket.id}\n`);
    expect(env).toContain("LAISSO_STAGE=implement\n");
    expect(env).toContain("LAISSO_PR=\n");
    expect(env).toContain("LAISSO_FILE=CHANGELOG.md\n");
    expect(env).toContain("LAISSO_PATTERN=dark\n");
  });

  it("Flags artifact.missing on exit 1, with the check's last line", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await runImplement(laisso);
    await checkNow(laisso);
    const d = await judged(laisso, ticket.id);
    expect(d.flag).toEqual({ reason: "artifact.missing", detail: "action grep-file: no dark in CHANGELOG.md", at: expect.any(String) });
    expect(d.sessions).toHaveLength(1);
    // The Ticket keeps the latest check at the Stage for its page.
    expect(d.check).toEqual({ action: "grep-file", result: "not_met", at: expect.any(String), code: 1, line: "no dark in CHANGELOG.md" });
  });

  it("Flags artifact.error on any other exit, a timeout, or a missing Action", async () => {
    const broken = await laissoWithTicket({ "grep-file": { params: ["file", "pattern"], run: 'echo "gh: not logged in" >&2; exit 4' } });
    await runImplement(broken.laisso);
    await checkNow(broken.laisso);
    const brokenDetail = await judged(broken.laisso, broken.ticket.id);
    expect(brokenDetail.flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: grep-file exited 4: gh: not logged in" });
    expect(brokenDetail.check).toMatchObject({ result: "error", code: 4 });

    const slow = await laissoWithTicket({ "grep-file": { params: ["file", "pattern"], timeout: "1s", run: "sleep 30" } });
    await runImplement(slow.laisso);
    await checkNow(slow.laisso);
    expect((await judged(slow.laisso, slow.ticket.id)).flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: grep-file timed out after 1s" });

    // The Action goes from config.yaml by hand after Intake: the check cannot run.
    const gone = await laissoWithTicket();
    const file = path.join(gone.laisso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("grep-file:", "grep-other:"));
    await runImplement(gone.laisso);
    await checkNow(gone.laisso);
    expect((await judged(gone.laisso, gone.ticket.id)).flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: no Action named grep-file in config.yaml" });
  });

  it("is checked on Mark done with warn-and-override", async () => {
    const { laisso, ticket } = await laissoWithTicket();
    await runImplement(laisso);
    await checkNow(laisso);
    const flagged = await judged(laisso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "artifact.missing" });

    const refused = await laisso.api<Response>(`/api/tickets/${ticket.id}/done`, { method: "POST", body: "{}", raw: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "action grep-file: no dark in CHANGELOG.md", artifact: "action grep-file", detail: "no dark in CHANGELOG.md", override: true });

    // A human fixes it by hand; the check now passes and Mark done advances without override.
    await writeFile(path.join(flagged.worktree, "CHANGELOG.md"), "dark mode\n");
    const done = await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}/done`, { method: "POST", body: "{}" });
    expect(done.stage.name).toBe("ship");
    // Each check overwrote the one before; ship has no check, so the view shows none.
    expect(done.check).toBeNull();
    const row = await laisso.api<TicketDetail>(`/api/tickets/${ticket.id}`);
    expect(row.sessions.map((s) => s.stage)).toEqual(["implement"]);
  });

  it("must name an Action the repo has, with its params, at Intake and on save", async () => {
    const started = await startLaissoWithRepos({ app: { pipeline: "check" } }, { actions: {} }, { check: PIPELINE });
    running.push(started.laisso);
    const laisso = started.laisso;
    await expect(laisso.api("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "check" }) })).rejects.toThrow(/Stage implement artifact: no Action named grep-file in config\.yaml/);
    await expect(laisso.api("/api/pipelines/check", { method: "PUT", body: JSON.stringify({ text: PIPELINE }) })).rejects.toThrow(/Stage implement artifact: no Action named grep-file in config\.yaml/);
  });
});
