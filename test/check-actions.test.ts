import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso, type LassoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// A config Action as a Stage's Artifact (ADR 0014, LASSO-115): run once the
// Runner succeeds and on Mark done, judged by exit code.
const running: Lasso[] = [];
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
const GREP: LassoConfig["actions"] = {
  "grep-file": {
    params: ["file", "pattern"],
    run: 'env | grep ^LASSO_ | sort > ../check-env.txt; if grep -q "$LASSO_PATTERN" "$LASSO_FILE" 2>/dev/null; then echo "found $LASSO_PATTERN"; else echo "no $LASSO_PATTERN in $LASSO_FILE"; exit 1; fi',
  },
};

async function lassoWithTicket(actions: LassoConfig["actions"] = GREP, pipeline = PIPELINE) {
  const started = await startLassoWithRepos({ app: { pipeline: "check" } }, { actions }, { check: pipeline });
  running.push(started.lasso);
  const ticket = await started.lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "check" }) });
  return { lasso: started.lasso, ticket };
}

const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
/** The Runner's Session ended and Lasso has judged it: the Ticket moved on or Flagged. */
const judged = (lasso: Lasso, id: string) => waitFor(async () => {
  const d = await detailOf(lasso, id);
  return d.session && !d.session.running && (d.stage.name !== "implement" || d.flag) ? d : null;
}, "the Stage to be judged");

async function runImplement(lasso: Lasso, files: Record<string, string> = {}) {
  await lasso.runner.script({ stdout: claudeFixture("success.json"), files });
}

describe("a check Action artifact", () => {
  it("advances on exit 0, run in the worktree with the Ticket's variables and its params", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await runImplement(lasso, { "CHANGELOG.md": "Added dark mode\n" });
    await checkNow(lasso);
    const d = await judged(lasso, ticket.id);
    expect(d.flag).toBeNull();
    expect(d.stage.name).toBe("ship");
    // A check records no Session of its own.
    expect(d.sessions.map((s) => s.stage)).toEqual(["implement"]);
    const env = await readFile(path.join(d.worktree, "..", "check-env.txt"), "utf8");
    expect(env).toContain(`LASSO_TICKET=${ticket.id}\n`);
    expect(env).toContain("LASSO_STAGE=implement\n");
    expect(env).toContain("LASSO_PR=\n");
    expect(env).toContain("LASSO_FILE=CHANGELOG.md\n");
    expect(env).toContain("LASSO_PATTERN=dark\n");
  });

  it("Flags artifact.missing on exit 1, with the check's last line", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await runImplement(lasso);
    await checkNow(lasso);
    const d = await judged(lasso, ticket.id);
    expect(d.flag).toEqual({ reason: "artifact.missing", detail: "action grep-file: no dark in CHANGELOG.md", at: expect.any(String) });
    expect(d.sessions).toHaveLength(1);
  });

  it("Flags artifact.error on any other exit, a timeout, or a missing Action", async () => {
    const broken = await lassoWithTicket({ "grep-file": { params: ["file", "pattern"], run: 'echo "gh: not logged in" >&2; exit 4' } });
    await runImplement(broken.lasso);
    await checkNow(broken.lasso);
    expect((await judged(broken.lasso, broken.ticket.id)).flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: grep-file exited 4: gh: not logged in" });

    const slow = await lassoWithTicket({ "grep-file": { params: ["file", "pattern"], timeout: "1s", run: "sleep 30" } });
    await runImplement(slow.lasso);
    await checkNow(slow.lasso);
    expect((await judged(slow.lasso, slow.ticket.id)).flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: grep-file timed out after 1s" });

    // The Action goes from config.yaml by hand after Intake: the check cannot run.
    const gone = await lassoWithTicket();
    const file = path.join(gone.lasso.home, "config.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("grep-file:", "grep-other:"));
    await runImplement(gone.lasso);
    await checkNow(gone.lasso);
    expect((await judged(gone.lasso, gone.ticket.id)).flag).toMatchObject({ reason: "artifact.error", detail: "action grep-file: no Action named grep-file in config.yaml" });
  });

  it("is checked on Mark done with warn-and-override", async () => {
    const { lasso, ticket } = await lassoWithTicket();
    await runImplement(lasso);
    await checkNow(lasso);
    const flagged = await judged(lasso, ticket.id);
    expect(flagged.flag).toMatchObject({ reason: "artifact.missing" });

    const refused = await lasso.api<Response>(`/api/tickets/${ticket.id}/done`, { method: "POST", body: "{}", raw: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "action grep-file: no dark in CHANGELOG.md", artifact: "action grep-file", detail: "no dark in CHANGELOG.md", override: true });

    // A human fixes it by hand; the check now passes and Mark done advances without override.
    await writeFile(path.join(flagged.worktree, "CHANGELOG.md"), "dark mode\n");
    const done = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}/done`, { method: "POST", body: "{}" });
    expect(done.stage.name).toBe("ship");
  });

  it("must name an Action the repo has, with its params, at Intake and on save", async () => {
    const started = await startLassoWithRepos({ app: { pipeline: "check" } }, { actions: {} }, { check: PIPELINE });
    running.push(started.lasso);
    const lasso = started.lasso;
    await expect(lasso.api("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "check" }) })).rejects.toThrow(/Stage implement artifact: no Action named grep-file in config\.yaml/);
    await expect(lasso.api("/api/pipelines/check", { method: "PUT", body: JSON.stringify({ text: PIPELINE }) })).rejects.toThrow(/Stage implement artifact: no Action named grep-file in config\.yaml/);
  });
});
