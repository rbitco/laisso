import { describe, it, expect, afterEach } from "vitest";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { startLaissoWithRepos, waitFor, type Laisso, type LaissoConfig } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Actions defined in config.yaml run as shell commands for action Stages (ADR 0010, LASSO-51).
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

// A command Stage, then a human Stage the Ticket rests at once the Action succeeds.
const NOTIFY = `stages:
  - action: notify
    name: notify
    with: { channel: ops }
  - name: implement
    human: true
    prompt: Do the work.
`;

const ACTIONS: LaissoConfig["actions"] = {
  notify: {
    params: ["channel"],
    run: 'pwd > seen.txt; env | grep ^LAISSO_ | sort >> seen.txt; echo "working"; echo "told $LAISSO_CHANNEL about $LAISSO_TITLE"',
  },
};

async function laissoWith(actions: LaissoConfig["actions"], pipelines: Record<string, string> = { notify: NOTIFY }) {
  const started = await startLaissoWithRepos({ app: { pipeline: "notify" } }, { actions }, pipelines);
  running.push(started.laisso);
  return started;
}

const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const intake = (laisso: Laisso, input: string) => laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo: "app", pipeline: "notify" }) });

async function actionEnded(laisso: Laisso, id: string): Promise<TicketDetail> {
  await checkNow(laisso);
  return waitFor(async () => {
    const detail = await detailOf(laisso, id);
    const session = detail.sessions.find((s) => s.mode === "action");
    return session && !session.running && (detail.stage.name !== "notify" || detail.flag) ? detail : null;
  }, "the Action to end");
}

describe("A config Action", () => {
  it("runs in the worktree with the Ticket's variables, keeps its output, and advances on exit 0", async () => {
    const { laisso } = await laissoWith(ACTIONS);
    const ticket = await intake(laisso, "Tell ops");
    const detail = await actionEnded(laisso, ticket.id);

    expect(detail.stage.name).toBe("implement");
    expect(detail.flag).toBeNull();
    const session = detail.sessions.find((s) => s.mode === "action")!;
    expect(session).toMatchObject({ stage: "notify", outcome: "succeeded", finalMessage: "told ops about Tell ops", latestMessage: "told ops about Tell ops" });

    const seen = (await readFile(path.join(detail.worktree, "seen.txt"), "utf8")).split("\n");
    expect(await realpath(seen[0]!)).toBe(await realpath(detail.worktree));
    const vars = Object.fromEntries(seen.slice(1).filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(vars).toMatchObject({
      LAISSO_TICKET: ticket.id,
      LAISSO_REFERENCE: "",
      LAISSO_REPO: "app",
      LAISSO_BRANCH: detail.branch,
      LAISSO_STAGE: "notify",
      LAISSO_SESSION: session.id,
      LAISSO_TITLE: "Tell ops",
      LAISSO_TRACKER: "jira",
      LAISSO_PROJECT: "APP",
      LAISSO_PR: "",
      LAISSO_WORKTREE: detail.worktree,
      LAISSO_PIPELINE: "notify",
      LAISSO_CHANNEL: "ops",
    });

    // The Session pane reads the command's output like a Runner's.
    const out = await laisso.api<{ text: string; ended: boolean }>(`/api/tickets/${ticket.id}/sessions/${session.id}/stdout`);
    expect(out).toMatchObject({ text: "working\ntold ops about Tell ops\n", ended: true });
  });

  it("Flags the Ticket on a non-zero exit, with the output's last line", async () => {
    const { laisso } = await laissoWith({ notify: { params: ["channel"], run: 'echo "no route to $LAISSO_CHANNEL" >&2; exit 3' } });
    const ticket = await intake(laisso, "Tell ops");
    const detail = await actionEnded(laisso, ticket.id);

    expect(detail.stage.name).toBe("notify");
    expect(detail.flag).toMatchObject({ reason: "outcome.failed", detail: "notify exited 3: no route to ops" });
    expect(detail.sessions.find((s) => s.mode === "action")).toMatchObject({ outcome: "failed" });
  });

  it("kills a command past its timeout and Flags the Ticket", async () => {
    const { laisso } = await laissoWith({ notify: { params: ["channel"], timeout: "1s", run: "echo started; sleep 30" } });
    const ticket = await intake(laisso, "Tell ops");
    const started = Date.now();
    await checkNow(laisso);
    // While the command runs its Session is open and the Ticket reads as running.
    expect((await detailOf(laisso, ticket.id)).display).toMatchObject({ state: "running", why: "notify, running its command" });
    // Its last line so far is its Latest Message, while it runs.
    await waitFor(async () => ((await detailOf(laisso, ticket.id)).session?.latestMessage === "started" ? true : null), "the Latest Message");
    const detail = await actionEnded(laisso, ticket.id);

    expect(Date.now() - started).toBeLessThan(8000);
    expect(detail.flag).toMatchObject({ reason: "outcome.failed", detail: "notify timed out after 1s" });
    expect(detail.sessions.find((s) => s.mode === "action")).toMatchObject({ finalMessage: "notify timed out after 1s", latestMessage: "started" });
  });

  it("keeps the last non-empty line as its Latest Message, even with no newline after it", async () => {
    const { laisso } = await laissoWith({ notify: { params: ["channel"], run: "printf 'first\\n\\nlast line\\n  \\n'; printf 'really last' >&2" } });
    const ticket = await intake(laisso, "Tell ops");
    const detail = await actionEnded(laisso, ticket.id);
    expect(detail.sessions.find((s) => s.mode === "action")).toMatchObject({ outcome: "succeeded", latestMessage: "really last" });
  });

  it("is read from config.yaml when it runs, so a hand edit counts without a restart", async () => {
    const { laisso } = await laissoWith({ notify: { params: ["channel"], run: "exit 1" } });
    const configFile = path.join(laisso.home, "config.yaml");
    const config = parse(await readFile(configFile, "utf8"));
    await writeFile(configFile, stringify({ ...config, actions: { notify: { params: ["channel"], run: "echo edited" } } }));
    const ticket = await intake(laisso, "Tell ops");
    const detail = await actionEnded(laisso, ticket.id);
    expect(detail.sessions.find((s) => s.mode === "action")).toMatchObject({ outcome: "succeeded", finalMessage: "edited" });
  });
});

describe("An action Stage naming a config Action", () => {
  it("is refused at save and at Intake when the Action is unknown or a param is missing or extra", async () => {
    const { laisso } = await laissoWith(ACTIONS, {});
    const save = (text: string) => laisso.api<Response>("/api/pipelines/notify", { method: "PUT", raw: true, body: JSON.stringify({ text }) });

    const unknown = await save(NOTIFY.replace("action: notify", "action: page"));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/Stage notify: no Action named page in config\.yaml/);

    const missing = await save(NOTIFY.replace("with: { channel: ops }", "with: {}"));
    expect((await missing.json()).error).toMatch(/notify needs with\.channel/);

    const extra = await save(NOTIFY.replace("with: { channel: ops }", "with: { channel: ops, loud: yes }"));
    expect((await extra.json()).error).toMatch(/notify takes no param loud/);

    expect((await save(NOTIFY)).status).toBe(200);

    // A Pipeline edited by hand to name an Action config lacks is refused at Intake, before any Ticket exists.
    await writeFile(path.join(laisso.home, "pipelines", "notify.yaml"), NOTIFY.replace("action: notify", "action: page"));
    await expect(intake(laisso, "Tell ops")).rejects.toThrow(/no Action named page in config\.yaml/);
  });
});

describe("A repo's own Action", () => {
  // app overrides notify and alone defines deploy; web has only the global notify.
  async function twoRepos(pipelines: Record<string, string>) {
    const started = await startLaissoWithRepos(
      {
        app: { pipeline: "notify", actions: { notify: { params: ["channel"], run: 'echo "app told $LAISSO_CHANNEL"' }, deploy: { params: ["env"], run: 'echo "deployed to $LAISSO_ENV"' } } },
        web: { pipeline: "notify" },
      },
      { actions: { notify: { params: ["channel"], run: 'echo "global told $LAISSO_CHANNEL"' } } },
      pipelines,
    );
    running.push(started.laisso);
    return started.laisso;
  }
  const intakeInto = (laisso: Laisso, repo: string, pipeline: string) =>
    laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Tell ops", repo, pipeline }) });
  const finalMessage = async (laisso: Laisso, id: string) => (await actionEnded(laisso, id)).sessions.find((s) => s.mode === "action")!.finalMessage;

  it("replaces the global one for that repo's Tickets, and only theirs", async () => {
    const laisso = await twoRepos({ notify: NOTIFY });
    const app = await intakeInto(laisso, "app", "notify");
    const web = await intakeInto(laisso, "web", "notify");
    expect(await finalMessage(laisso, app.id)).toBe("app told ops");
    expect(await finalMessage(laisso, web.id)).toBe("global told ops");
  });

  it("may exist only in the repo: Intake checks it against the repo, and saving accepts it", async () => {
    const DEPLOY = NOTIFY.replace("action: notify\n    name: notify\n    with: { channel: ops }", "action: deploy\n    name: deploy\n    with: { env: prod }");
    const laisso = await twoRepos({ notify: NOTIFY, deploy: DEPLOY });
    const save = (text: string) => laisso.api<Response>("/api/pipelines/deploy", { method: "PUT", raw: true, body: JSON.stringify({ text }) });
    expect((await save(DEPLOY)).status).toBe(200);
    const missing = await save(DEPLOY.replace("with: { env: prod }", "with: {}"));
    expect((await missing.json()).error).toMatch(/deploy needs with\.env/);

    const app = await intakeInto(laisso, "app", "deploy");
    expect(await finalMessage(laisso, app.id)).toBe("deployed to prod");
    await expect(intakeInto(laisso, "web", "deploy")).rejects.toThrow(/no Action named deploy in config\.yaml/);
  });
});
