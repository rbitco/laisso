import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, startLasso, waitFor, claudeFixture, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { PipelineFile, PipelineListing, ConfigFile } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";

// Seam one: Pipelines and config are edited through the API the dashboard
// uses, in place, with comments and ordering kept (LASSO-40).
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const WORK = `# The work Pipeline. Keep this comment.
runner: claude   # the default Runner

stages:
  - name: implement    # first
    prompt: Do the work.
    artifact: commits-on-branch
    budget: { attempts: 1 }

  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

async function lassoWith(pipelines: Record<string, string> = { work: WORK }) {
  const started = await startLassoWithRepos({ app: { pipeline: "work" } }, {}, pipelines);
  running.push(started.lasso);
  return started.lasso;
}

const intake = (lasso: Lasso, title: string) =>
  lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: title, repo: "app", pipeline: "work" }) });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (lasso: Lasso) => lasso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pipelineText = (lasso: Lasso, name: string) => readFile(path.join(lasso.home, "pipelines", `${name}.yaml`), "utf8");
const json = (body: unknown) => JSON.stringify(body);

describe("Pipeline files", () => {
  it("lists every Pipeline with its Stages and reads one with its text", async () => {
    const lasso = await lassoWith();
    const listing = await lasso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.map((p) => p.name)).toEqual(["default", "work"]);
    expect(listing[1]).toMatchObject({ name: "work", problem: null, stages: [{ name: "implement", kind: "runner", label: "implement" }, { name: "notes", kind: "runner", label: "notes" }] });
    expect(listing[0]!.stages.map((s) => s.label)).toContain("In Progress");

    const file = await lasso.api<PipelineFile>("/api/pipelines/work");
    expect(file.text).toBe(WORK);
    expect(file.file).toBe(path.join(lasso.home, "pipelines", "work.yaml"));
    // A Stage without a runner of its own shows null, so the editor can offer the Pipeline's as the default.
    expect(file.pipeline).toMatchObject({ runner: "claude", budget: {}, stages: [{ name: "implement", prompt: "Do the work.", artifact: "commits-on-branch", runner: null, budget: { attempts: 1 } }, { name: "notes", runner: null }] });

    const missing = await lasso.api<Response>("/api/pipelines/ghost", { raw: true });
    expect(missing.status).toBe(404);
    // A name that is a path reaches nothing outside the pipelines directory.
    expect((await lasso.api<Response>("/api/pipelines/..%2Fconfig", { raw: true })).status).toBe(404);
    expect((await lasso.api<Response>("/api/pipelines/..%2Fconfig", { method: "DELETE", raw: true })).status).toBe(404);
    await expect(lasso.api("/api/pipelines/..%2Fconfig", { method: "PATCH", body: json({ tick: 1 }) })).rejects.toThrow(/does not exist/);
    expect(await readFile(path.join(lasso.home, "config.yaml"), "utf8")).toContain("tick:");
  });

  it("patches Stages and the Pipeline in place, keeping comments and order", async () => {
    const lasso = await lassoWith();
    const after = await lasso.api<PipelineFile>("/api/pipelines/work", {
      method: "PATCH",
      body: json({ runner: "codex", budget: { spend: 10 }, stages: { implement: { prompt: "Do it well.\nThen stop.\n", budget: { attempts: null, wallTime: "5m" }, human: true }, notes: { artifact: null, runner: "pi" } } }),
    });
    expect(after.pipeline).toMatchObject({ runner: "codex", budget: { spend: 10 }, stages: [{ name: "implement", prompt: "Do it well.\nThen stop.\n", human: true, budget: { wallTime: "5m" }, runner: null }, { name: "notes", artifact: null, runner: "pi" }] });
    expect(after.pipeline!.stages[0]).toMatchObject({ kind: "runner", budget: expect.not.objectContaining({ attempts: expect.anything() }) });

    const text = await pipelineText(lasso, "work");
    expect(text).toContain("# The work Pipeline. Keep this comment.");
    expect(text).toContain("runner: codex # the default Runner");
    expect(text).toContain("- name: implement # first");
    expect(text).not.toContain("attempts");
    expect(text).not.toContain("file NOTES.md");
    expect(text.indexOf("name: implement")).toBeLessThan(text.indexOf("name: notes"));
    expect(text).toBe(after.text);
    expect((await lasso.api<PipelineFile>("/api/pipelines/work")).text).toBe(text);
  });

  it("refuses a patch that breaks a rule and leaves the file alone", async () => {
    const lasso = await lassoWith();
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { artifact: "pr-approved" } } }) })).rejects.toThrow(/unknown artifact pr-approved/);
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { action: "tracker.transition" } } }) })).rejects.toThrow(/has both action and prompt\/skills/);
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { ghost: { prompt: "x" } } }) })).rejects.toThrow(/Pipeline work has no Stage named ghost/);
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { name: "notes" } } }) })).rejects.toThrow(/has two Stages named notes/);
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ colour: "red" }) })).rejects.toThrow(/unknown field colour/);
    await expect(lasso.api("/api/pipelines/work", { method: "PATCH", body: json("runner: pi") })).rejects.toThrow(/patch must be a mapping/);
    expect(await pipelineText(lasso, "work")).toBe(WORK);
  });

  it("creates a Pipeline from text, replaces it, refuses bad text or a bad name, and deletes it", async () => {
    const lasso = await lassoWith();
    const text = "runner: pi\nstages:\n  - name: only\n    prompt: One.\n";
    const created = await lasso.api<PipelineFile>("/api/pipelines/spike", { method: "PUT", body: json({ text }) });
    expect(created).toMatchObject({ name: "spike", text, pipeline: { runner: "pi", stages: [{ name: "only" }] } });
    expect(await pipelineText(lasso, "spike")).toBe(text);
    expect((await lasso.api<PipelineListing[]>("/api/pipelines")).map((p) => p.name)).toEqual(["default", "spike", "work"]);

    await expect(lasso.api("/api/pipelines/spike", { method: "PUT", body: json({ text: "stages: []\n" }) })).rejects.toThrow(/Pipeline spike has no stages/);
    await expect(lasso.api("/api/pipelines/Spike%20Two", { method: "PUT", body: json({ text }) })).rejects.toThrow(/Pipeline name must be lowercase letters, digits, and hyphens/);
    await expect(lasso.api("/api/pipelines/spike", { method: "PUT", body: json({}) })).rejects.toThrow(/text must be the whole Pipeline file/);
    await expect(lasso.api("/api/pipelines/spike", { method: "PUT", body: "null" })).rejects.toThrow(/text must be the whole Pipeline file/);
    // The dashboard's Create sends create: true, so a typo cannot replace a Pipeline that exists.
    await expect(lasso.api("/api/pipelines/spike", { method: "PUT", body: json({ text, create: true }) })).rejects.toThrow(/Pipeline spike already exists/);
    expect(await pipelineText(lasso, "spike")).toBe(text);

    const replaced = await lasso.api<PipelineFile>("/api/pipelines/spike", { method: "PUT", body: json({ text: text + "    artifact: pr-exists\n" }) });
    expect(replaced.pipeline!.stages[0]).toMatchObject({ artifact: "pr-exists" });

    await lasso.api("/api/pipelines/spike", { method: "DELETE" });
    expect((await lasso.api<PipelineListing[]>("/api/pipelines")).map((p) => p.name)).toEqual(["default", "work"]);
    expect((await lasso.api<Response>("/api/pipelines/spike", { method: "DELETE", raw: true })).status).toBe(404);
  });

  it("keeps a dashboard edit of default.yaml across a restart", async () => {
    const lasso = await lassoWith();
    const edited = await lasso.api<PipelineFile>("/api/pipelines/default", { method: "PATCH", body: json({ stages: { plan: { prompt: "Plan briefly.\n" } } }) });
    expect(edited.text).toContain("# Lasso's default Pipeline. Edit freely: Lasso never overwrites this file.");
    expect(edited.text).toContain("Plan briefly.");
    await lasso.stop();
    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    expect((await again.api<PipelineFile>("/api/pipelines/default")).text).toBe(edited.text);
  });

  it("lists a Pipeline whose file is broken with the problem, and intake refuses it", async () => {
    const lasso = await lassoWith({ work: WORK, broken: "runner: claude\nstages:\n  - name: x\n    artifact: pr-exists\n" });
    const listing = await lasso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.find((p) => p.name === "broken")).toMatchObject({ stages: [], problem: expect.stringMatching(/needs a prompt, skills, or an action/) });
    await expect(lasso.api("/api/tickets", { method: "POST", body: json({ input: "x", repo: "app", pipeline: "broken" }) })).rejects.toThrow(/needs a prompt, skills, or an action/);
  });

  it("Flags pipeline.missing at the next advance when the Pipeline is deleted under a running Ticket", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script({ delayMs: 800, commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") });
    const ticket = await intake(lasso, "A");
    await checkNow(lasso);
    expect((await detailOf(lasso, ticket.id)).display.state).toBe("running");
    await lasso.api("/api/pipelines/work", { method: "DELETE" });
    // The running Stage was snapshotted: the Session still ends on its own terms.
    const flagged = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag ? d : null; }, "the Ticket to be Flagged");
    expect(flagged.flag).toMatchObject({ reason: "pipeline.missing", detail: expect.stringMatching(/Pipeline work does not exist/) });
    expect(flagged.session).toMatchObject({ stage: "implement", outcome: "succeeded" });
    expect(flagged.stage.name).toBe("implement");
    expect(flagged.display.state).toBe("flagged");
  });

  it("Flags pipeline.missing at the next advance when the running Stage was renamed", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script({ delayMs: 800, commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") });
    const ticket = await intake(lasso, "A");
    await checkNow(lasso);
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { name: "build" } } }) });
    const flagged = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.flag ? d : null; }, "the Ticket to be Flagged");
    expect(flagged.flag).toMatchObject({ reason: "pipeline.missing", detail: "Pipeline work no longer has a Stage named implement" });
    expect(flagged.session).toMatchObject({ stage: "implement", outcome: "succeeded" });
  });
});

describe("config.yaml", () => {
  it("reads the file and patches every editable key in place, keeping comments", async () => {
    const lasso = await lassoWith();
    const file = path.join(lasso.home, "config.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "# my config\n" + (await readFile(file, "utf8")).replace(/^tick: 3600$/m, "tick: 3600 # slow"));

    const before = await lasso.api<ConfigFile>("/api/config");
    expect(before.file).toBe(file);
    expect(before.text).toContain("# my config");
    expect(before.config).toMatchObject({ tick: 3600, concurrency: 3, retention: 30, branch_prefix: "", notifications: { enabled: true, flagged: true, human: true, gate: true }, budget: { rounds: 5, attempts: 2, wallTime: "30m", spend: 25 } });

    const after = await lasso.api<ConfigFile>("/api/config", {
      method: "PATCH",
      body: json({ budget: { rounds: 3, attempts: 4, wallTime: "1h", spend: 12.5 }, tick: 30, concurrency: 5, retention: 7, branch_prefix: "mw", notifications: { enabled: false, flagged: false, human: false, gate: false }, port: 7500 }),
    });
    expect(after.config).toMatchObject({ tick: 30, concurrency: 5, retention: 7, branch_prefix: "mw", port: 7500, notifications: { enabled: false, flagged: false, human: false, gate: false }, budget: { rounds: 3, attempts: 4, wallTime: "1h", spend: 12.5 } });
    expect(after.restart.sort()).toEqual(["port", "tick"]);
    expect(after.text).toContain("# my config");
    expect(after.text).toContain("tick: 30 # slow");
    expect(await readFile(file, "utf8")).toBe(after.text);
    expect((await lasso.api<ConfigFile>("/api/config")).config).toEqual(after.config);

    // Live keys apply at once: the next intake carries the new prefix.
    const ticket = await intake(lasso, "Prefixed");
    expect(ticket.branch).toMatch(/^mw\//);
    // A cleared key falls back to the default and leaves the file without it.
    const cleared = await lasso.api<ConfigFile>("/api/config", { method: "PATCH", body: json({ branch_prefix: null, budget: { rounds: null } }) });
    expect(cleared.config).toMatchObject({ branch_prefix: "", budget: { rounds: 5 } });
    expect(cleared.restart).toEqual([]);
    expect(cleared.text).not.toMatch(/branch_prefix/);
  });

  it("refuses a patch that would not load, and leaves the file alone", async () => {
    const lasso = await lassoWith();
    const file = path.join(lasso.home, "config.yaml");
    const text = await readFile(file, "utf8");
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ concurrency: 0 }) })).rejects.toThrow(/concurrency must be a whole number of 1 or more/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ budget: { wallTime: "soon" } }) })).rejects.toThrow(/budget\.wallTime .*soon/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ tick: "often" }) })).rejects.toThrow(/tick must be a whole number of 1 or more/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ notifications: { loud: true } }) })).rejects.toThrow(/unknown field notifications\.loud/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ repos: {} }) })).rejects.toThrow(/repos are edited in config\.yaml by hand/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({}) })).rejects.toThrow(/nothing to change/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

describe("the dashboard", () => {
  it("carries the Pipeline and config editors", async () => {
    const lasso = await lassoWith();
    const html = await (await lasso.page("/")).text();
    expect(html).toContain('data-role="pipelines"');
    expect(html).toContain('data-role="config"');
    expect(html).toContain('href="#pipelines"');
    expect(html).toContain('href="#config"');
  });
});
