import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startLaissoWithRepos, startLaisso, waitFor, claudeFixture, runCli, type Laisso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { PipelineFile, PipelineListing, ConfigFile, PipelineVersionView, ActionListing } from "../src/api/views.ts";
import type { TickChange } from "../src/server/tick.ts";
import { DEFAULT_CONFIG } from "../src/server/config.ts";
import { PR_REVIEW_PIPELINE_YAML } from "../src/pipeline/pr-review.ts";
import { checkActions, fileArtifact, parsePipeline } from "../src/pipeline/load.ts";
import { addStage, draftOf, moveStage, paramsOf, pipelinePatch, removeStage, type RunnerDraft } from "../src/dashboard/app/pipelines/stages.ts";

// Seam one: Pipelines and config are edited through the API the dashboard
// uses, in place, with comments and ordering kept (LASSO-40).
const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

/** The migration's runner-only profiles, beside the shipped ones the default Pipeline names. */
const PROFILES = { ...DEFAULT_CONFIG.profiles, claude: { runner: "claude" as const }, codex: { runner: "codex" as const }, pi: { runner: "pi" as const } };

const WORK = `# The work Pipeline. Keep this comment.
profile: claude   # the default profile

stages:
  - name: implement    # first
    prompt: Do the work.
    artifact: commits-on-branch
    budget: { attempts: 1 }

  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

async function laissoWith(pipelines: Record<string, string> = { work: WORK }) {
  const started = await startLaissoWithRepos({ app: { pipeline: "work" } }, { profiles: PROFILES }, pipelines);
  running.push(started.laisso);
  return started.laisso;
}

const intake = (laisso: Laisso, title: string) =>
  laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: title, repo: "app", pipeline: "work" }) });
const detailOf = (laisso: Laisso, id: string) => laisso.api<TicketDetail>(`/api/tickets/${id}`);
const checkNow = (laisso: Laisso) => laisso.api<{ changes: TickChange[] }>("/api/check-now", { method: "POST" });
const pipelineText = (laisso: Laisso, name: string) => readFile(path.join(laisso.home, "pipelines", `${name}.yaml`), "utf8");
const json = (body: unknown) => JSON.stringify(body);

describe("Pipeline files", () => {
  it("lists every Pipeline with its Stages and reads one with its text", async () => {
    const laisso = await laissoWith();
    const listing = await laisso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.map((p) => p.name)).toEqual(["default", "pr-review", "work"]);
    expect(listing[2]).toMatchObject({ name: "work", problem: null, stages: [{ name: "implement", kind: "runner", label: "implement" }, { name: "notes", kind: "runner", label: "notes" }] });
    expect(listing[0]!.stages.map((s) => s.label)).toContain("In Progress");

    const file = await laisso.api<PipelineFile>("/api/pipelines/work");
    expect(file.text).toBe(WORK);
    expect(file.file).toBe(path.join(laisso.home, "pipelines", "work.yaml"));
    // A Stage without a profile of its own shows null, so the editor can offer the Pipeline's as the default.
    expect(file.pipeline).toMatchObject({ profile: "claude", budget: {}, stages: [{ name: "implement", prompt: "Do the work.", artifact: "commits-on-branch", profile: null, budget: { attempts: 1 } }, { name: "notes", profile: null }] });

    const missing = await laisso.api<Response>("/api/pipelines/ghost", { raw: true });
    expect(missing.status).toBe(404);
    // A name that is a path reaches nothing outside the pipelines directory.
    expect((await laisso.api<Response>("/api/pipelines/..%2Fconfig", { raw: true })).status).toBe(404);
    expect((await laisso.api<Response>("/api/pipelines/..%2Fconfig", { method: "DELETE", raw: true })).status).toBe(404);
    await expect(laisso.api("/api/pipelines/..%2Fconfig", { method: "PATCH", body: json({ tick: 1 }) })).rejects.toThrow(/does not exist/);
    expect(await readFile(path.join(laisso.home, "config.yaml"), "utf8")).toContain("tick:");
  });

  it("patches Stages and the Pipeline in place, keeping comments and order", async () => {
    const laisso = await laissoWith();
    const after = await laisso.api<PipelineFile>("/api/pipelines/work", {
      method: "PATCH",
      body: json({ profile: "codex", budget: { spend: 10 }, stages: { implement: { prompt: "Do it well.\nThen stop.\n", budget: { attempts: null, wallTime: "5m" }, human: true }, notes: { artifact: null, profile: "pi" } } }),
    });
    expect(after.pipeline).toMatchObject({ profile: "codex", budget: { spend: 10 }, stages: [{ name: "implement", prompt: "Do it well.\nThen stop.\n", human: true, budget: { wallTime: "5m" }, profile: null }, { name: "notes", artifact: null, profile: "pi" }] });
    expect(after.pipeline!.stages[0]).toMatchObject({ kind: "runner", budget: expect.not.objectContaining({ attempts: expect.anything() }) });

    const text = await pipelineText(laisso, "work");
    expect(text).toContain("# The work Pipeline. Keep this comment.");
    expect(text).toContain("profile: codex # the default profile");
    expect(text).toContain("- name: implement # first");
    expect(text).not.toContain("attempts");
    expect(text).not.toContain("file NOTES.md");
    expect(text.indexOf("name: implement")).toBeLessThan(text.indexOf("name: notes"));
    expect(text).toBe(after.text);
    expect((await laisso.api<PipelineFile>("/api/pipelines/work")).text).toBe(text);
  });

  it("sets and clears a Stage's and the Pipeline's profile as the editor's profile button and dropdown save them, keeping comments", async () => {
    const laisso = await laissoWith();
    // "Use claude-fable for implement", and the Pipeline dropdown back to config default.
    const set = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ profile: null, stages: { implement: { profile: "claude-fable" } } }) });
    expect(set.pipeline).toMatchObject({ profile: null, stages: [{ name: "implement", profile: "claude-fable" }, { name: "notes", profile: null }] });
    // The file's header comment sat on the cleared first key; it stays at the top.
    expect(set.text.startsWith("# The work Pipeline. Keep this comment.\n\nstages:\n")).toBe(true);
    expect(set.text).toContain("  - name: implement # first\n    prompt: Do the work.\n    artifact: commits-on-branch\n    budget: { attempts: 1 }\n    profile: claude-fable\n");
    expect(set.text).not.toMatch(/^profile:/m);

    // "Inherit instead" on implement, and the dropdown set to a profile again.
    const cleared = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ profile: "claude-sonnet", stages: { implement: { profile: null } } }) });
    expect(cleared.pipeline).toMatchObject({ profile: "claude-sonnet", stages: [{ name: "implement", profile: null }, { name: "notes", profile: null }] });
    expect(cleared.text).toContain("# The work Pipeline. Keep this comment.");
    expect(cleared.text).toMatch(/^profile: claude-sonnet$/m);
    expect(cleared.text).toContain("  - name: implement # first\n");
    expect(cleared.text).not.toContain("claude-fable");
    expect(await pipelineText(laisso, "work")).toBe(cleared.text);

    // An unknown profile, from the button or the dropdown, is refused as a hand edit is, and the file stays.
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { profile: "claude-ghost" } } }) })).rejects.toThrow(/Pipeline work Stage implement: no profile named claude-ghost in config\.yaml/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ profile: "claude-ghost" }) })).rejects.toThrow(/Pipeline work: no profile named claude-ghost in config\.yaml/);
    expect(await pipelineText(laisso, "work")).toBe(cleared.text);
  });

  it("removes Stages named out of the order, keeping the others' comments, with field edits and renames in the same save", async () => {
    const THREE = WORK + `
  # ship it
  - name: ship    # last
    prompt: Ship.
`;
    const laisso = await laissoWith({ work: THREE });
    const after = await laisso.api<PipelineFile>("/api/pipelines/work", {
      method: "PATCH",
      body: json({ order: ["implement", "ship"], stages: { implement: { name: "build" }, ship: { prompt: "Ship it." } } }),
    });
    expect(after.pipeline!.stages.map((s) => s.name)).toEqual(["build", "ship"]);
    expect(after.text).toBe(`# The work Pipeline. Keep this comment.
profile: claude # the default profile

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
    const first = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["ship"] }) });
    expect(first.text).toContain("stages:\n  # ship it\n  - name: ship # last\n");
    expect(first.text).not.toContain("name: build");
  });

  it("reorders Stages, each moving with its comments, alongside a field edit", async () => {
    const laisso = await laissoWith();
    // A no-op patch gives the file as the YAML writer lays it out, the baseline to come back to.
    const original = (await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({}) })).text;
    const after = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["notes", "implement"], stages: { notes: { prompt: "Notes first." } } }) });
    expect(after.pipeline!.stages.map((s) => s.name)).toEqual(["notes", "implement"]);
    expect(after.text).toBe(`# The work Pipeline. Keep this comment.
profile: claude # the default profile

stages:
  - name: notes
    prompt: Notes first.
    artifact: file NOTES.md

  - name: implement # first
    prompt: Do the work.
    artifact: commits-on-branch
    budget: { attempts: 1 }
`);
    // And back again, with the prompt restored: the original file, byte for byte.
    const back = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", "notes"], stages: { notes: { prompt: "Write NOTES.md." } } }) });
    expect(back.text).toBe(original);
  });

  it("keeps the file byte for byte when the order is unchanged", async () => {
    const laisso = await laissoWith();
    const same = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", "notes"] }) });
    const untouched = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({}) });
    expect(same.text).toBe(untouched.text);
  });

  it("refuses an order that empties the Pipeline, names a Stage twice, or names no Stage, and leaves the file alone", async () => {
    const laisso = await laissoWith();
    const patch = (order: unknown) => laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ order }) });
    await expect(patch([])).rejects.toThrow(/Pipeline work must keep at least one Stage/);
    await expect(patch(["implement", "implement"])).rejects.toThrow(/order names Stage implement twice/);
    await expect(patch(["implement", "ghost"])).rejects.toThrow(/Pipeline work has no Stage named ghost/);
    await expect(patch("implement")).rejects.toThrow(/order must be a list of Stage names/);
    expect(await pipelineText(laisso, "work")).toBe(WORK);
  });

  it("adds a Runner Stage in position alongside other edits, keeping every comment", async () => {
    const laisso = await laissoWith();
    const review = { name: "review", prompt: "Review the work.", skills: ["code-review"], artifact: null, human: true };
    const after = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", review, "notes"], stages: { implement: { name: "build" } } }) });
    expect(after.pipeline!.stages.map((s) => s.name)).toEqual(["build", "review", "notes"]);
    expect(after.text).toBe(`# The work Pipeline. Keep this comment.
profile: claude # the default profile

stages:
  - name: build # first
    prompt: Do the work.
    artifact: commits-on-branch
    budget: { attempts: 1 }

  - name: review
    prompt: Review the work.
    skills: [ code-review ]
    human: true

  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`);
    // A new first Stage takes the place of the old one without taking its comment.
    const first = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: [{ name: "plan", prompt: "Plan it." }, "build", "review", "notes"] }) });
    expect(first.text).toContain("stages:\n  - name: plan\n    prompt: Plan it.\n\n  - name: build # first\n");
  });

  it("adds a tracker.transition action Stage in position, and refuses one without its status", async () => {
    const laisso = await laissoWith();
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", { action: "tracker.transition", with: {} }, "notes"] }) })).rejects.toThrow(/tracker\.transition needs with\.status/);
    const after = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", { action: "tracker.transition", with: { status: "In Review" } }, "notes"] }) });
    expect(after.pipeline!.stages.map((s) => s.name)).toEqual(["implement", "transition-in-review", "notes"]);
    expect(after.text).toContain(`    budget: { attempts: 1 }

  - action: tracker.transition
    with: { status: In Review }

  - name: notes
`);
    // Saved, it is an ordinary action Stage: moved by the name it is known by.
    const moved = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ order: ["implement", "notes", "transition-in-review"] }) });
    expect(moved.pipeline!.stages.map((s) => s.name)).toEqual(["implement", "notes", "transition-in-review"]);
  });

  it("refuses a new Stage that repeats a name or has nothing to run, and leaves the file alone", async () => {
    const laisso = await laissoWith();
    const patch = (order: unknown) => laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ order }) });
    await expect(patch(["implement", { name: "notes", prompt: "Again." }, "notes"])).rejects.toThrow(/Pipeline work has two Stages named notes/);
    await expect(patch(["implement", { name: "review" }, "notes"])).rejects.toThrow(/Pipeline work stage 2 needs a prompt, skills, an action, or a wait/);
    await expect(patch(["implement", { prompt: "No name." }])).rejects.toThrow(/stage 2 needs a name/);
    expect(await pipelineText(laisso, "work")).toBe(WORK);
  });

  it("leaves a live Ticket on its Version when a Stage is removed", async () => {
    const laisso = await laissoWith();
    const ticket = await intake(laisso, "A");
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ order: ["notes"] }) });
    const d = await detailOf(laisso, ticket.id);
    expect(d.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
    expect(d).toMatchObject({ pipelineVersion: 1, pipelineDrift: "changed", flag: null });
  });

  it("refuses a patch that breaks a rule and leaves the file alone", async () => {
    const laisso = await laissoWith();
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { artifact: "pr-approved" } } }) })).rejects.toThrow(/unknown artifact pr-approved/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { action: "tracker.transition" } } }) })).rejects.toThrow(/has both action and prompt\/skills/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { ghost: { prompt: "x" } } }) })).rejects.toThrow(/Pipeline work has no Stage named ghost/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { name: "notes" } } }) })).rejects.toThrow(/has two Stages named notes/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ colour: "red" }) })).rejects.toThrow(/unknown field colour/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json("profile: pi") })).rejects.toThrow(/patch must be a mapping/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { notes: { profile: "opus" } } }) })).rejects.toThrow(/Pipeline work Stage notes: no profile named opus in config\.yaml/);
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ runner: "codex" }) })).rejects.toThrow(/runner is now an Agent Profile in config\.yaml; write profile: codex/);
    await expect(laisso.api("/api/pipelines/work", { method: "PUT", body: json({ text: "profile: opus\nstages:\n  - name: x\n    prompt: p\n" }) })).rejects.toThrow(/Pipeline work: no profile named opus in config\.yaml/);
    expect(await pipelineText(laisso, "work")).toBe(WORK);
  });

  it("creates a Pipeline from text, replaces it, refuses bad text or a bad name, and deletes it", async () => {
    const laisso = await laissoWith();
    const text = "profile: pi\nstages:\n  - name: only\n    prompt: One.\n";
    const created = await laisso.api<PipelineFile>("/api/pipelines/spike", { method: "PUT", body: json({ text }) });
    expect(created).toMatchObject({ name: "spike", text, pipeline: { profile: "pi", stages: [{ name: "only" }] } });
    expect(await pipelineText(laisso, "spike")).toBe(text);
    expect((await laisso.api<PipelineListing[]>("/api/pipelines")).map((p) => p.name)).toEqual(["default", "pr-review", "spike", "work"]);

    await expect(laisso.api("/api/pipelines/spike", { method: "PUT", body: json({ text: "stages: []\n" }) })).rejects.toThrow(/Pipeline spike has no stages/);
    await expect(laisso.api("/api/pipelines/Spike%20Two", { method: "PUT", body: json({ text }) })).rejects.toThrow(/Pipeline name must be lowercase letters, digits, and hyphens/);
    await expect(laisso.api("/api/pipelines/spike", { method: "PUT", body: json({}) })).rejects.toThrow(/text must be the whole Pipeline file/);
    await expect(laisso.api("/api/pipelines/spike", { method: "PUT", body: "null" })).rejects.toThrow(/text must be the whole Pipeline file/);
    // The dashboard's Create sends create: true, so a typo cannot replace a Pipeline that exists.
    await expect(laisso.api("/api/pipelines/spike", { method: "PUT", body: json({ text, create: true }) })).rejects.toThrow(/Pipeline spike already exists/);
    expect(await pipelineText(laisso, "spike")).toBe(text);

    const replaced = await laisso.api<PipelineFile>("/api/pipelines/spike", { method: "PUT", body: json({ text: text + "    artifact: pr-exists\n" }) });
    expect(replaced.pipeline!.stages[0]).toMatchObject({ artifact: "pr-exists" });

    await laisso.api("/api/pipelines/spike", { method: "DELETE" });
    expect((await laisso.api<PipelineListing[]>("/api/pipelines")).map((p) => p.name)).toEqual(["default", "pr-review", "work"]);
    expect((await laisso.api<Response>("/api/pipelines/spike", { method: "DELETE", raw: true })).status).toBe(404);
  });

  it("keeps a dashboard edit of default.yaml across a restart", async () => {
    const laisso = await laissoWith();
    const edited = await laisso.api<PipelineFile>("/api/pipelines/default", { method: "PATCH", body: json({ stages: { plan: { prompt: "Plan briefly.\n" } } }) });
    expect(edited.text).toContain("# Laisso's default Pipeline. Edit freely: Laisso never overwrites this file.");
    expect(edited.text).toContain("Plan briefly.");
    await laisso.stop();
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    expect((await again.api<PipelineFile>("/api/pipelines/default")).text).toBe(edited.text);
  });

  it("lists a Pipeline whose file is broken with the problem, and intake refuses it", async () => {
    const laisso = await laissoWith({ work: WORK, broken: "stages:\n  - name: x\n    artifact: pr-exists\n" });
    const listing = await laisso.api<PipelineListing[]>("/api/pipelines");
    expect(listing.find((p) => p.name === "broken")).toMatchObject({ stages: [], problem: expect.stringMatching(/needs a prompt, skills, an action, or a wait/) });
    await expect(laisso.api("/api/tickets", { method: "POST", body: json({ input: "x", repo: "app", pipeline: "broken" }) })).rejects.toThrow(/needs a prompt, skills, an action, or a wait/);
  });

});

// Seam two: a Ticket runs the Version of its Pipeline it was pinned to at Intake (LASSO-42, ADR 0009).
describe("Pipeline Versions", () => {
  const committing = { commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], stdout: claudeFixture("success.json") };
  const launchedWith = async (laisso: Laisso, text: string) => (await laisso.runner.calls()).some((c) => c.argv.some((a) => a.includes(text)));

  it("numbers a Version only when Intake meets content that differs from the last", async () => {
    const laisso = await laissoWith();
    const a = await intake(laisso, "A");
    const b = await intake(laisso, "B");
    expect((await detailOf(laisso, a.id)).pipelineVersion).toBe(1);
    expect((await detailOf(laisso, b.id)).pipelineVersion).toBe(1);
    // An edit no Ticket is bound to gets no number of its own.
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it once." } } }) });
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it twice." } } }) });
    const c = await intake(laisso, "C");
    expect((await detailOf(laisso, c.id)).pipelineVersion).toBe(2);
    expect((await detailOf(laisso, a.id)).pipelineVersion).toBe(1);
    const status = await runCli(["status", c.id], laisso);
    expect(status.stdout).toMatch(/^pipeline: +work v2$/m);
  });

  it("runs the pinned prompt and Budget after the file is edited", async () => {
    const laisso = await laissoWith();
    await laisso.runner.script(committing);
    const ticket = await intake(laisso, "A");
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Edited prompt.", budget: { attempts: 5 } } } }) });
    expect((await detailOf(laisso, ticket.id)).budget.attempts).toMatchObject({ limit: 1, source: "pipeline" });
    await checkNow(laisso);
    await waitFor(async () => ((await detailOf(laisso, ticket.id)).stage.name === "notes" ? true : null), "the Ticket to reach notes");
    expect(await launchedWith(laisso, "Do the work.")).toBe(true);
    expect(await launchedWith(laisso, "Edited prompt.")).toBe(false);
  });

  it("carries on with its Version when the Pipeline is deleted under it", async () => {
    const laisso = await laissoWith();
    await laisso.runner.script({ delayMs: 800, ...committing });
    const deleted = await intake(laisso, "A");
    await checkNow(laisso);
    await laisso.api("/api/pipelines/work", { method: "DELETE" });
    const moved = await waitFor(async () => { const d = await detailOf(laisso, deleted.id); return d.stage.name === "notes" ? d : null; }, "the Ticket to reach notes");
    expect(moved.flag).toBeNull();
    expect(moved.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
    expect(moved.pipeline).toBe("work");
    expect(moved.pipelineVersion).toBe(1);
  });

  it("carries on with its Version when the running Stage is renamed in the file", async () => {
    const laisso = await laissoWith();
    await laisso.runner.script({ delayMs: 800, ...committing });
    const ticket = await intake(laisso, "A");
    await checkNow(laisso);
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { name: "build" } } }) });
    const moved = await waitFor(async () => { const d = await detailOf(laisso, ticket.id); return d.stage.name === "notes" ? d : null; }, "the Ticket to reach notes");
    expect(moved.flag).toBeNull();
  });

  it("pins Tickets from before Versions to their file as v1 on start, leaving one whose file is gone unpinned", async () => {
    const laisso = await laissoWith({ work: WORK, gone: WORK });
    const kept = await intake(laisso, "A");
    const orphan = await laisso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "B", repo: "app", pipeline: "gone" }) });
    await laisso.stop();
    // Rewind the store to before Versions: no Version rows, no pins.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(laisso.home, "laisso.db"));
    db.exec("DELETE FROM pipeline_versions; UPDATE tickets SET pipeline_version = NULL;");
    db.close();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(laisso.home, "pipelines", "gone.yaml"));

    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
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
    const laisso = await laissoWith();
    const ticket = await intake(laisso, "A");
    expect((await detailOf(laisso, ticket.id)).pipelineDrift).toBe("same");
    // A comment-only edit is the same content.
    const file = path.join(laisso.home, "pipelines", "work.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "# a new comment\n" + WORK);
    expect((await detailOf(laisso, ticket.id)).pipelineDrift).toBe("same");
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { notes: { prompt: "Write better notes." } } }) });
    expect((await detailOf(laisso, ticket.id)).pipelineDrift).toBe("changed");
    await writeFile(file, "stages: nope\n");
    expect((await detailOf(laisso, ticket.id)).pipelineDrift).toBe("broken");
    await laisso.api("/api/pipelines/work", { method: "DELETE" });
    const gone = await detailOf(laisso, ticket.id);
    expect(gone).toMatchObject({ pipeline: "work", pipelineVersion: 1, pipelineDrift: "deleted" });
    expect(gone.stages.map((s) => s.name)).toEqual(["implement", "notes"]);
  });

  it("reads a Version read-only, after its file is deleted too, and lists the Versions active Tickets run", async () => {
    const laisso = await laissoWith();
    const a = await intake(laisso, "A");
    const b = await intake(laisso, "B");
    await laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { implement: { prompt: "Do it again." } } }) });
    await intake(laisso, "C");
    expect(await laisso.api("/api/pipelines/work/versions")).toEqual([
      { version: 1, createdAt: expect.any(String), live: 2 },
      { version: 2, createdAt: expect.any(String), live: 1 },
    ]);
    // A Version no active Ticket runs drops off the list.
    for (const t of [a, b]) await laisso.api(`/api/tickets/${t.id}/abandon`, { method: "POST" });
    expect((await laisso.api<Array<{ version: number; live: number }>>("/api/pipelines/work/versions")).map((v) => [v.version, v.live])).toEqual([[2, 1]]);

    await laisso.api("/api/pipelines/work", { method: "DELETE" });
    const v1 = await laisso.api<PipelineVersionView>("/api/pipelines/work/versions/1");
    expect(v1).toMatchObject({ name: "work", version: 1, deleted: true, pipeline: { profile: "claude", stages: [{ name: "implement", prompt: "Do the work.", profile: null, budget: { attempts: 1 } }, { name: "notes" }] } });
    expect((await laisso.api<PipelineVersionView>("/api/pipelines/work/versions/2")).pipeline.stages[0]).toMatchObject({ prompt: "Do it again." });
    expect((await laisso.api<Response>("/api/pipelines/work/versions/3", { raw: true })).status).toBe(404);
    expect((await laisso.api<Response>("/api/pipelines/work/versions/x", { raw: true })).status).toBe(404);
    // Read-only: there is nothing to write a Version with.
    expect((await laisso.api<Response>("/api/pipelines/work/versions/1", { method: "PUT", body: json({ text: WORK }), raw: true })).status).toBe(404);
  });
});

describe("config.yaml", () => {
  it("reads the file and patches every editable key in place, keeping comments", async () => {
    const laisso = await laissoWith();
    const file = path.join(laisso.home, "config.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "# my config\n" + (await readFile(file, "utf8")).replace(/^tick: 3600$/m, "tick: 3600 # slow"));

    const before = await laisso.api<ConfigFile>("/api/config");
    expect(before.file).toBe(file);
    expect(before.text).toContain("# my config");
    expect(before.config).toMatchObject({ tick: 3600, concurrency: 3, retention: 30, branch_prefix: "", notifications: { enabled: true, flagged: true, human: true, gate: true }, budget: { rounds: 5, attempts: 2, wallTime: "30m", spend: 25 } });

    const after = await laisso.api<ConfigFile>("/api/config", {
      method: "PATCH",
      body: json({ budget: { rounds: 3, attempts: 4, wallTime: "1h", spend: 12.5 }, tick: 30, concurrency: 5, retention: 7, branch_prefix: "mw", notifications: { enabled: false, flagged: false, human: false, gate: false }, port: 7500 }),
    });
    expect(after.config).toMatchObject({ tick: 30, concurrency: 5, retention: 7, branch_prefix: "mw", port: 7500, notifications: { enabled: false, flagged: false, human: false, gate: false }, budget: { rounds: 3, attempts: 4, wallTime: "1h", spend: 12.5 } });
    expect(after.restart.sort()).toEqual(["port", "tick"]);
    expect(after.text).toContain("# my config");
    expect(after.text).toContain("tick: 30 # slow");
    expect(await readFile(file, "utf8")).toBe(after.text);
    expect((await laisso.api<ConfigFile>("/api/config")).config).toEqual(after.config);

    // Live keys apply at once: the next intake carries the new prefix.
    const ticket = await intake(laisso, "Prefixed");
    expect(ticket.branch).toMatch(/^mw\//);
    // A cleared key falls back to the default and leaves the file without it.
    const cleared = await laisso.api<ConfigFile>("/api/config", { method: "PATCH", body: json({ branch_prefix: null, budget: { rounds: null } }) });
    expect(cleared.config).toMatchObject({ branch_prefix: "", budget: { rounds: 5 } });
    expect(cleared.restart).toEqual([]);
    expect(cleared.text).not.toMatch(/branch_prefix/);
  });

  it("refuses a patch that would not load, and leaves the file alone", async () => {
    const laisso = await laissoWith();
    const file = path.join(laisso.home, "config.yaml");
    const text = await readFile(file, "utf8");
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({ concurrency: 0 }) })).rejects.toThrow(/concurrency must be a whole number of 1 or more/);
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({ budget: { wallTime: "soon" } }) })).rejects.toThrow(/budget\.wallTime .*soon/);
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({ tick: "often" }) })).rejects.toThrow(/tick must be a whole number of 1 or more/);
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({ notifications: { loud: true } }) })).rejects.toThrow(/unknown field notifications\.loud/);
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({ repos: {} }) })).rejects.toThrow(/repos are edited in config\.yaml by hand/);
    await expect(laisso.api("/api/config", { method: "PATCH", body: json({}) })).rejects.toThrow(/nothing to change/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

describe("config Actions in the Pipeline editor", () => {
  const NOTIFY = `stages:
  - name: implement
    prompt: Do the work.
  - name: tell
    action: notify
    with: { channel: ops }
`;
  async function laissoWithActions() {
    const started = await startLaissoWithRepos(
      { app: { pipeline: "work" }, web: { pipeline: "work", actions: { notify: { params: ["channel"], run: "echo web", timeout: "1m" }, deploy: { params: ["env", "region"], run: "./deploy" } } } },
      { actions: { notify: { params: ["channel"], run: 'echo "told $LAISSO_CHANNEL"' } } },
      { work: NOTIFY },
    );
    running.push(started.laisso);
    return started.laisso;
  }

  it("lists every Action config defines, global then per repo, as config.yaml has it now", async () => {
    const laisso = await laissoWithActions();
    const listed = await laisso.api<ActionListing[]>("/api/actions");
    expect(listed.filter((a) => a.name !== "tracker.transition" && a.repo !== "app")).toEqual([
      { name: "notify", repo: null, params: ["channel"], timeout: "60s", run: 'echo "told $LAISSO_CHANNEL"' },
      { name: "deploy", repo: "web", params: ["env", "region"], timeout: "60s", run: "./deploy" },
      { name: "notify", repo: "web", params: ["channel"], timeout: "1m", run: "echo web" },
    ]);
    expect(listed.find((a) => a.name === "tracker.transition")).toMatchObject({ repo: null, params: ["status"] });
    // Actions are edited by hand; the listing follows the file without a restart.
    const file = path.join(laisso.home, "config.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, (await readFile(file, "utf8")) + "\n# added by hand\n");
    await writeFile(file, (await readFile(file, "utf8")).replace('echo "told $LAISSO_CHANNEL"', "echo edited"));
    expect((await laisso.api<ActionListing[]>("/api/actions")).find((a) => a.name === "notify" && a.repo === null)!.run).toBe("echo edited");
  });

  it("edits a saved action Stage's params and Action as the editor sends them, and refuses a param left empty", async () => {
    const laisso = await laissoWithActions();
    // The editor sends a blank param as null: the Stage then lacks it, and the save says so.
    await expect(laisso.api("/api/pipelines/work", { method: "PATCH", body: json({ stages: { tell: { with: { channel: null } } } }) })).rejects.toThrow(/Stage tell: notify needs with\.channel/);
    const changed = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ stages: { tell: { with: { channel: "dev" } } } }) });
    expect(changed.pipeline!.stages[1]).toMatchObject({ name: "tell", action: "notify", with: { channel: "dev" } });
    // Picking another Action swaps its params: the old one's go, the new one's come in.
    const swapped = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json({ stages: { tell: { action: "deploy", with: { channel: null, env: "prod", region: "eu" } } } }) });
    expect(swapped.pipeline!.stages[1]).toMatchObject({ name: "tell", action: "deploy", with: { env: "prod", region: "eu" } });
    expect(swapped.text).toContain("    action: deploy\n    with: { env: prod, region: eu }\n");
  });

  it("writes a check Action artifact as the editor sends it, and back to a built-in", async () => {
    const laisso = await laissoWithActions();
    const patch = (body: unknown) => laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json(body) });
    const checked = await patch({ stages: { implement: { artifact: { action: "deploy", with: { env: "prod", region: "eu" } } } } });
    expect(checked.text).toContain("    artifact:\n      action: deploy\n      with: { env: prod, region: eu }\n");
    // What the editor opens it as, and an edit to one param sends the whole artifact again.
    const draft = draftOf(checked.pipeline!);
    expect(draft.cards[0]!.draft).toMatchObject({ artifact: "action deploy", artifactWith: { env: "prod", region: "eu" } });
    const edited = { ...draft, cards: draft.cards.map((c, i) => (i === 0 ? { ...c, draft: { ...(c.draft as RunnerDraft), artifactWith: { env: "prod", region: "us" } } } : c)) };
    const params = paramsOf(await laisso.api<ActionListing[]>("/api/actions"));
    const regioned = await patch(pipelinePatch(checked.pipeline!, edited, params));
    expect(regioned.text).toContain("      with: { env: prod, region: us }\n");
    await expect(patch({ stages: { implement: { artifact: { action: "notify", with: {} } } } })).rejects.toThrow(/Stage implement artifact: notify needs with\.channel/);
    const plain = await patch({ stages: { implement: { artifact: "commits-on-branch" } } });
    expect(plain.text).toContain("    artifact: commits-on-branch\n  - name: tell\n");
  });
});

describe("the Stage editor's save", () => {
  it("writes an edit, an add, a move and a removal in one patch, keeping comments and the other Stages as they were", async () => {
    const THREE = WORK + `
  # ship it
  - name: ship    # last
    prompt: Ship.
`;
    const laisso = await laissoWith({ work: THREE });
    const file = await laisso.api<PipelineFile>("/api/pipelines/work");
    const draft = draftOf(file.pipeline!);
    const [implement, notes, ship] = draft.cards;
    // implement's prompt and attempts edited; a Stage added after it; ship moved first; notes removed.
    const edited: RunnerDraft = { ...(implement!.draft as RunnerDraft), prompt: "Do the work well.", attempts: "" };
    let cards = draft.cards.map((c) => (c.id === implement!.id ? { ...c, draft: edited } : c));
    cards = addStage(cards, implement!.id, "runner");
    cards = cards.map((c) => (c.fresh ? { ...c, draft: { ...(c.draft as RunnerDraft), name: "review", prompt: "Review it.", rounds: "2", advance: false } } : c));
    cards = moveStage(moveStage(moveStage(cards, ship!.id, -1), ship!.id, -1), ship!.id, -1);
    cards = removeStage(cards, notes!.id);
    const patch = pipelinePatch(file.pipeline!, { ...draft, cards }, {});
    expect(patch).toEqual({
      stages: { implement: { prompt: "Do the work well.", budget: { attempts: null } } },
      order: ["ship", "implement", { budget: { rounds: 2 }, name: "review", prompt: "Review it.", advance: false }],
    });

    const after = await laisso.api<PipelineFile>("/api/pipelines/work", { method: "PATCH", body: json(patch) });
    expect(after.text).toBe(`# The work Pipeline. Keep this comment.
profile: claude # the default profile

stages:
  # ship it
  - name: ship # last
    prompt: Ship.

  - name: implement # first
    prompt: Do the work well.
    artifact: commits-on-branch

  - budget:
      rounds: 2
    name: review
    prompt: Review it.
    advance: false
`);
  });
});

// The pr-review Pipeline (LASSO-168): shipped beside default, for a Ticket that reviews a teammate's PR.
describe("the pr-review Pipeline", () => {
  it("is written on first run and left alone after, like default.yaml", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    expect(await pipelineText(laisso, "pr-review")).toBe(PR_REVIEW_PIPELINE_YAML);

    await laisso.stop();
    const edited = PR_REVIEW_PIPELINE_YAML + "# hand edit\n";
    await writeFile(path.join(laisso.home, "pipelines", "pr-review.yaml"), edited);
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    expect(await pipelineText(again, "pr-review")).toBe(edited);
  });

  it("loads with one headless Stage that needs no skill, writes a file Artifact, and has no tracker Actions", async () => {
    const pipeline = parsePipeline("pr-review", PR_REVIEW_PIPELINE_YAML);
    expect(() => checkActions(pipeline, {})).not.toThrow();
    expect(pipeline.stages).toHaveLength(1);
    const stage = pipeline.stages[0]!;
    if (stage.kind !== "runner") throw new Error("pr-review's Stage is not a Runner Stage");
    expect(stage).toMatchObject({ name: "review-pr", human: false, skills: [], profile: null, artifact: "file review-findings.md" });
    expect(fileArtifact(stage.artifact!)).toBe("review-findings.md");
    // It reads the Referenced PRs and posts nothing: the human does.
    expect(stage.prompt).toContain("laisso pr list --json");
    expect(stage.prompt).toContain("Do not post anything to any PR");

    const laisso = await startLaisso();
    running.push(laisso);
    const listed = (await laisso.api<PipelineListing[]>("/api/pipelines")).find((p) => p.name === "pr-review");
    expect(listed).toMatchObject({ problem: null, stages: [{ name: "review-pr", kind: "runner" }] });
  });
});
