import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startLassoWithRepos, startLasso, waitFor, claudeFixture, runCli, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { PipelineFile, PipelineListing, ConfigFile, PipelineVersionView } from "../src/api/views.ts";
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

  it("removes Stages named out of the order, keeping the others' comments, with field edits and renames in the same save", async () => {
    const THREE = WORK + `
  # ship it
  - name: ship    # last
    prompt: Ship.
`;
    const lasso = await lassoWith({ work: THREE });
    const after = await lasso.api<PipelineFile>("/api/pipelines/work", {
      method: "PATCH",
      body: json({ order: ["implement", "ship"], stages: { implement: { name: "build" }, ship: { prompt: "Ship it." } } }),
    });
    expect(after.pipeline!.stages.map((s) => s.name)).toEqual(["build", "ship"]);
    expect(after.text).toBe(`# The work Pipeline. Keep this comment.
runner: claude # the default Runner

stages:
  - name: build # first
    prompt: Do the work.
    artifact: commits-on-branch
    budget: { attempts: 1 }

  # ship it
  - name: ship # last
    prompt: Ship it.
`);
    // Removing the first Stage hands its comment to nobody and the next Stage's to the top.
    const first = await lasso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["ship"] }) });
    expect(first.text).toContain("stages:\n  # ship it\n  - name: ship # last\n");
    expect(first.text).not.toContain("name: build");
  });

  it("keeps the file byte for byte when the order is unchanged", async () => {
    const lasso = await lassoWith();
    const same = await lasso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", "notes"] }) });
    const untouched = await lasso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({}) });
    expect(same.text).toBe(untouched.text);
  });

  it("refuses an order that empties the Pipeline, names a Stage twice, or names no Stage, and leaves the file alone", async () => {
    const lasso = await lassoWith();
    const patch = (order: unknown) => lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ order }) });
    await expect(patch([])).rejects.toThrow(/Pipeline work must keep at least one Stage/);
    await expect(patch(["implement", "implement"])).rejects.toThrow(/order names Stage implement twice/);
    await expect(patch(["implement", "ghost"])).rejects.toThrow(/Pipeline work has no Stage named ghost/);
    await expect(patch("implement")).rejects.toThrow(/order must be a list of Stage names/);
    expect(await pipelineText(lasso, "work")).toBe(WORK);
  });

  it("leaves a live Ticket on its Version when a Stage is removed", async () => {
    const lasso = await lassoWith();
    const ticket = await intake(lasso, "A");
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ order: ["notes"] }) });
    const d = await detailOf(lasso, ticket.id);
    expect(d.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
    expect(d).toMatchObject({ pipelineVersion: 1, pipelineDrift: "changed", flag: null });
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

});

// Seam two: a Ticket runs the Version of its Pipeline it was pinned to at Intake (LASSO-42, ADR 0009).
describe("Pipeline Versions", () => {
  const committing = { commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") };
  const launchedWith = async (lasso: Lasso, text: string) => (await lasso.runner.calls()).some((c) => c.argv.some((a) => a.includes(text)));

  it("numbers a Version only when Intake meets content that differs from the last", async () => {
    const lasso = await lassoWith();
    const a = await intake(lasso, "A");
    const b = await intake(lasso, "B");
    expect((await detailOf(lasso, a.id)).pipelineVersion).toBe(1);
    expect((await detailOf(lasso, b.id)).pipelineVersion).toBe(1);
    // An edit no Ticket is bound to gets no number of its own.
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it once." } } }) });
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it twice." } } }) });
    const c = await intake(lasso, "C");
    expect((await detailOf(lasso, c.id)).pipelineVersion).toBe(2);
    expect((await detailOf(lasso, a.id)).pipelineVersion).toBe(1);
    const status = await runCli(["status", c.id], lasso);
    expect(status.stdout).toMatch(/^pipeline: +work v2$/m);
  });

  it("runs the pinned prompt and Budget after the file is edited", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script(committing);
    const ticket = await intake(lasso, "A");
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Edited prompt.", budget: { attempts: 5 } } } }) });
    expect((await detailOf(lasso, ticket.id)).budget.attempts).toMatchObject({ limit: 1, source: "pipeline" });
    await checkNow(lasso);
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).stage.name === "notes" ? true : null), "the Ticket to reach notes");
    expect(await launchedWith(lasso, "Do the work.")).toBe(true);
    expect(await launchedWith(lasso, "Edited prompt.")).toBe(false);
  });

  it("carries on with its Version when the Pipeline is deleted under it", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script({ delayMs: 800, ...committing });
    const deleted = await intake(lasso, "A");
    await checkNow(lasso);
    await lasso.api("/api/pipelines/work", { method: "DELETE" });
    const moved = await waitFor(async () => { const d = await detailOf(lasso, deleted.id); return d.stage.name === "notes" ? d : null; }, "the Ticket to reach notes");
    expect(moved.flag).toBeNull();
    expect(moved.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
    expect(moved.pipeline).toBe("work");
    expect(moved.pipelineVersion).toBe(1);
  });

  it("carries on with its Version when the running Stage is renamed in the file", async () => {
    const lasso = await lassoWith();
    await lasso.runner.script({ delayMs: 800, ...committing });
    const ticket = await intake(lasso, "A");
    await checkNow(lasso);
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { name: "build" } } }) });
    const moved = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.stage.name === "notes" ? d : null; }, "the Ticket to reach notes");
    expect(moved.flag).toBeNull();
  });

  it("pins Tickets from before Versions to their file as v1 on start, leaving one whose file is gone unpinned", async () => {
    const lasso = await lassoWith({ work: WORK, gone: WORK });
    const kept = await intake(lasso, "A");
    const orphan = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "B", repo: "app", pipeline: "gone" }) });
    await lasso.stop();
    // Rewind the store to before Versions: no Version rows, no pins.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
    db.exec("DELETE FROM pipeline_versions; UPDATE tickets SET pipeline_version = NULL;");
    db.close();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(lasso.home, "pipelines", "gone.yaml"));

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    expect((await detailOf(again, kept.id)).pipelineVersion).toBe(1);
    expect((await detailOf(again, orphan.id)).pipelineVersion).toBeNull();
    // An unpinned Ticket still reads its file, so a missing one Flags as before.
    await again.runner.script(committing);
    await checkNow(again);
    const flagged = await waitFor(async () => { const d = await detailOf(again, orphan.id); return d.flag ? d : null; }, "the orphan to be Flagged");
    expect(flagged.flag).toMatchObject({ reason: "pipeline.missing", detail: expect.stringMatching(/Pipeline gone does not exist/) });
  });
});

// Seam three: what a human sees of a Ticket's Version against its Pipeline (LASSO-43).
describe("Version drift and read-only Versions", () => {
  it("says nothing while the file matches, then marks a changed, broken, or deleted Pipeline", async () => {
    const lasso = await lassoWith();
    const ticket = await intake(lasso, "A");
    expect((await detailOf(lasso, ticket.id)).pipelineDrift).toBe("same");
    // A comment-only edit is the same content.
    const file = path.join(lasso.home, "pipelines", "work.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "# a new comment\n" + WORK);
    expect((await detailOf(lasso, ticket.id)).pipelineDrift).toBe("same");
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { notes: { prompt: "Write better notes." } } }) });
    expect((await detailOf(lasso, ticket.id)).pipelineDrift).toBe("changed");
    await writeFile(file, "stages: nope\n");
    expect((await detailOf(lasso, ticket.id)).pipelineDrift).toBe("broken");
    await lasso.api("/api/pipelines/work", { method: "DELETE" });
    const gone = await detailOf(lasso, ticket.id);
    expect(gone).toMatchObject({ pipeline: "work", pipelineVersion: 1, pipelineDrift: "deleted" });
    expect(gone.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
  });

  it("reads a Version read-only, after its file is deleted too, and lists the Versions active Tickets run", async () => {
    const lasso = await lassoWith();
    const a = await intake(lasso, "A");
    const b = await intake(lasso, "B");
    await lasso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it again." } } }) });
    await intake(lasso, "C");
    expect(await lasso.api("/api/pipelines/work/versions")).toEqual([
      { version: 1, createdAt: expect.any(String), live: 2 },
      { version: 2, createdAt: expect.any(String), live: 1 },
    ]);
    // A Version no active Ticket runs drops off the list.
    for (const t of [a, b]) await lasso.api(`/api/tickets/${t.id}/abandon`, { method: "POST" });
    expect((await lasso.api<Array<{ version: number; live: number }>>("/api/pipelines/work/versions")).map((v) => [v.version, v.live])).toEqual([[2, 1]]);

    await lasso.api("/api/pipelines/work", { method: "DELETE" });
    const v1 = await lasso.api<PipelineVersionView>("/api/pipelines/work/versions/1");
    expect(v1).toMatchObject({ name: "work", version: 1, deleted: true, pipeline: { runner: "claude", stages: [{ name: "implement", prompt: "Do the work.", runner: null, budget: { attempts: 1 } }, { name: "notes" }] } });
    expect((await lasso.api<PipelineVersionView>("/api/pipelines/work/versions/2")).pipeline.stages[0]).toMatchObject({ prompt: "Do it again." });
    expect((await lasso.api<Response>("/api/pipelines/work/versions/3", { raw: true })).status).toBe(404);
    expect((await lasso.api<Response>("/api/pipelines/work/versions/x", { raw: true })).status).toBe(404);
    // Read-only: there is nothing to write a Version with.
    expect((await lasso.api<Response>("/api/pipelines/work/versions/1", { method: "PUT", body: json({ text: WORK }), raw: true })).status).toBe(404);
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
