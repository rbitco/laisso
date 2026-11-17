import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.ts";
import { PipelineFiles } from "../src/pipeline/files.ts";
import { DEFAULT_CONFIG } from "../src/server/config.ts";
import { detect } from "../src/intake/detect.ts";
import { PipelineVersions } from "../src/store/versions.ts";
import type { TicketRow } from "../src/store/tickets.ts";
import { loadPipeline, resolveEntries, resolvePipeline, overlay, PipelineError, type ReadPipeline, type Stage } from "../src/pipeline/load.ts";

// The resolver seam (LASSO-214..216): Pipelines loaded by name from in-memory texts.
export const texts =
  (files: Record<string, string>): ReadPipeline =>
  (name) =>
    files[name] ?? null;

describe("resolvePipeline", () => {
  it("loads a Pipeline by name through the reader it is given", () => {
    const read = texts({ solo: "stages:\n  - name: work\n    prompt: do it\n" });
    const pipeline = resolvePipeline("solo", read);
    expect(pipeline.name).toBe("solo");
    expect(pipeline.stages.map((s) => s.name)).toEqual(["work"]);
  });

  it("refuses a name the reader has nothing for", () => {
    expect(() => resolvePipeline("nope", texts({}))).toThrow(new PipelineError("no Pipeline named nope"));
  });

  it("sees a proposed edit laid over the others", () => {
    const read = overlay(texts({ solo: "stages:\n  - name: work\n    prompt: do it\n" }), "solo", "stages:\n  - name: other\n    prompt: p\n");
    expect(resolvePipeline("solo", read).stages[0]!.name).toBe("other");
    expect(() => resolvePipeline("solo", overlay(read, "solo", null))).toThrow(/no Pipeline named solo/);
  });
});

const DEFAULT = `profile: claude
stages:
  - name: plan
    human: true
    prompt: Agree a plan.
  - name: implement
    artifact: commits-on-branch
    budget: { rounds: 3, attempts: 2 }
    prompt: Carry out the plan.
    routes:
      replan: { to: plan, when: the plan is wrong }
  - action: tracker.transition
    with: { status: In Progress }
  - name: review
    repeat: feedback
    artifact: pr-merged
    prompt: Address feedback.
    routes:
      rework: { to: implement }
`;

const load = (files: Record<string, string>, name = "bug-fix") => resolvePipeline(name, texts({ default: DEFAULT, ...files }));
const stage = (files: Record<string, string>, stageName: string, name = "bug-fix") => load(files, name).stages.find((s) => s.name === stageName)!;
const runner = (s: Stage) => {
  if (s.kind !== "runner") throw new Error("not a runner Stage");
  return s;
};

describe("use: one Stage from another Pipeline", () => {
  it("copies the Stage, with its origin, among the Pipeline's own", () => {
    const p = load({ "bug-fix": "stages:\n  - name: triage\n    prompt: t\n  - use: default.plan\n" });
    expect(p.stages.map((s) => s.name)).toEqual(["triage", "plan"]);
    expect(p.stages[0]!.from).toBeUndefined();
    expect(p.stages[1]).toMatchObject({ kind: "runner", prompt: "Agree a plan.", human: true, from: { pipeline: "default", stage: "plan", how: "use" } });
  });

  it("names an unnamed action Stage by its derived name, and derives it afresh when with changes", () => {
    expect(stage({ "bug-fix": "stages:\n  - use: default.transition-in-progress\n" }, "transition-in-progress")).toMatchObject({ kind: "action", with: { status: "In Progress" } });
    const p = load({ "bug-fix": "stages:\n  - use: default.transition-in-progress\n    with: { status: Doing }\n" });
    expect(p.stages[0]).toMatchObject({ name: "transition-doing", with: { status: "Doing" }, from: { stage: "transition-in-progress" } });
  });

  it("prompt replaces, append adds after, and both is refused", () => {
    expect(runner(stage({ "bug-fix": "stages:\n  - use: default.plan\n    prompt: New.\n" }, "plan")).prompt).toBe("New.");
    expect(runner(stage({ "bug-fix": "stages:\n  - use: default.plan\n    append: Test first.\n" }, "plan")).prompt).toBe("Agree a plan.\n\nTest first.");
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n    prompt: a\n    append: b\n" })).toThrow(
      new PipelineError("Pipeline bug-fix stage 1 (use default.plan): set prompt or append, not both"),
    );
  });

  it("merges budget, routes and with key by key, null removing a key; lists replace", () => {
    const s = runner(stage({ "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n    budget: { rounds: 5, attempts: null }\n    skills: [tdd]\n    routes:\n      replan: null\n      again: { to: implement }\n" }, "implement"));
    expect(s.budget).toEqual({ rounds: 5, attempts: undefined, wallTime: undefined });
    expect(s.skills).toEqual(["tdd"]);
    expect(Object.keys(s.routes!)).toEqual(["again"]);
  });

  it("takes any other field but its kind, and renames with name:", () => {
    expect(stage({ "bug-fix": "stages:\n  - use: default.plan\n    name: think\n    human: false\n    profile: codex\n" }, "think")).toMatchObject({ human: false, profile: "codex", from: { stage: "plan" } });
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n    action: notify\n" })).toThrow(/stage 1 \(use default\.plan\): action does not fit a reused runner Stage/);
  });

  it("leaves an unset profile to the reusing Pipeline, and takes no Pipeline settings from the source", () => {
    const p = load({ "bug-fix": "profile: codex\nstages:\n  - use: default.plan\n" });
    expect(p.profile).toBe("codex");
    expect(runner(p.stages[0]!).profile).toBeNull();
  });

  it("checks the expanded Stage like any Stage", () => {
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n    artifact: nonsense\n" })).toThrow(new PipelineError("Pipeline bug-fix stage 1 (use default.plan): unknown artifact nonsense"));
  });

  it("refuses two Stages of one name, saying where each came from", () => {
    const files = { "review-parts": "stages:\n  - name: review\n    prompt: r\n", "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n  - name: x\n    prompt: x\n  - use: review-parts.review\n  - use: default.review\n" };
    expect(() => load(files)).toThrow(new PipelineError("Pipeline bug-fix: two Stages named review (stage 4 use review-parts.review, stage 5 use default.review)"));
  });

  it("resolves Routes by name after expansion, and does not follow a rename", () => {
    expect(load({ "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n" }).stages.map((s) => s.name)).toEqual(["plan", "implement"]);
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n    name: build\n  - use: default.review\n" })).toThrow(
      new PipelineError("Pipeline bug-fix Stage review (from default.review): Route rework goes to implement, which is not a Stage of bug-fix"),
    );
  });

  it("refuses a missing Stage, a missing Pipeline, a malformed use, and a source that does not load", () => {
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n  - use: default.plan2\n  - use: default.implement\n" })).toThrow(
      new PipelineError("Pipeline bug-fix stage 2 (use default.plan2): default has no Stage named plan2"),
    );
    expect(() => load({ "bug-fix": "stages:\n  - use: default.plan\n  - use: nope.x\n" })).toThrow(new PipelineError("Pipeline bug-fix stage 2 (use nope.x): no Pipeline named nope"));
    expect(() => load({ "bug-fix": "stages:\n  - use: default\n" })).toThrow(/stage 1: use must name <pipeline>\.<stage>, not default/);
    expect(() => load({ "bug-fix": "stages: []\n", hotfix: "stages:\n  - use: bug-fix.implement\n" }, "hotfix")).toThrow(
      new PipelineError("Pipeline hotfix stage 1 (use bug-fix.implement): bug-fix does not load"),
    );
  });

  it("copies through a chain as the middle Pipeline runs the Stage", () => {
    const files = { "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n    append: Test first.\n", hotfix: "stages:\n  - use: bug-fix.implement\n    routes: { replan: null }\n" };
    const s = runner(stage(files, "implement", "hotfix"));
    expect(s.prompt).toBe("Carry out the plan.\n\nTest first.");
    expect(s.from).toEqual({ pipeline: "bug-fix", stage: "implement", how: "use" });
  });

  it("refuses a reuse loop, named from the Pipeline it starts at", () => {
    const files = { a: "stages:\n  - use: b.x\n  - name: y\n    prompt: y\n", b: "stages:\n  - name: x\n    prompt: x\n  - use: a.y\n" };
    expect(() => resolvePipeline("a", texts(files))).toThrow("Pipeline a: reuse loop a → b → a");
    expect(() => resolvePipeline("b", texts(files))).toThrow("Pipeline b: reuse loop b → a → b");
    expect(() => resolvePipeline("c", texts({ ...files, c: "stages:\n  - use: a.y\n" }))).toThrow(new PipelineError("Pipeline c stage 1 (use a.y): a does not load"));
    expect(() => resolvePipeline("s", texts({ s: "stages:\n  - name: x\n    prompt: x\n  - use: s.x\n" }))).toThrow("Pipeline s: reuse loop s → s");
  });
});

describe("a Version of a reusing Pipeline", () => {
  it("stores each copied Stage's origin, and shows drift when the source changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "laisso-reuse-"));
    writeFileSync(path.join(dir, "default.yaml"), DEFAULT);
    writeFileSync(path.join(dir, "bug-fix.yaml"), "stages:\n  - use: default.plan\n  - name: fix\n    prompt: f\n");
    const versions = new PipelineVersions(new Store(":memory:").db);
    const version = versions.pin(loadPipeline(dir, "bug-fix"));
    expect(versions.get("bug-fix", version)!.stages[0]!.from).toEqual({ pipeline: "default", stage: "plan", how: "use" });
    const ticket = { pipeline: "bug-fix", pipeline_version: version } as TicketRow;
    expect(versions.drift(ticket, dir)).toBe("same");
    writeFileSync(path.join(dir, "default.yaml"), DEFAULT.replace("Agree a plan.", "Agree a better plan."));
    expect(versions.drift(ticket, dir)).toBe("changed");
    writeFileSync(path.join(dir, "default.yaml"), DEFAULT.replace("name: plan", "name: think"));
    expect(versions.drift(ticket, dir)).toBe("broken");
  });
});

describe("the Pipeline files of a reusing Pipeline", () => {
  it("load through the others, save as text, and refuse a field patch until the editor writes reuse entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "laisso-reuse-"));
    writeFileSync(path.join(dir, "default.yaml"), DEFAULT);
    const files = new PipelineFiles(dir, () => DEFAULT_CONFIG);
    const saved = files.write("bug-fix", "stages:\n  - use: default.plan\n");
    expect(saved).toMatchObject({ reuses: true, problem: null });
    expect(saved.pipeline!.stages[0]!.from).toEqual({ pipeline: "default", stage: "plan", how: "use" });
    expect(files.read("default")!.reuses).toBe(false);
    expect(() => files.write("bad", "stages:\n  - use: default.nope\n")).toThrow(/default has no Stage named nope/);
    expect(files.patch("bug-fix", { budget: { spend: 2 } }).pipeline!.budget).toEqual({ spend: 2 });
  });
});

describe("the entry rewriter: edits to the expanded list written as entries (LASSO-222)", () => {
  const FLOW = "stages:\n  - name: plan\n    prompt: Plan it.\n  - name: implement\n    prompt: Carry out the plan.\n    budget: { rounds: 3, attempts: 2 }\n  - name: review\n    prompt: Address feedback.\n    artifact: pr-merged\n";
  const BUG_FIX = `# Bug fixes reuse the flow.
stages:
  - include: flow
    to: implement
    skip: [ plan ]
    change:
      implement:
        append: Write a failing test first.
  # Our own check.
  - name: smoke
    prompt: Run it.
  - use: flow.review
    skills: [ code-review ]
`;
  const setup = (text = BUG_FIX) => {
    const dir = mkdtempSync(path.join(tmpdir(), "laisso-rewrite-"));
    writeFileSync(path.join(dir, "flow.yaml"), FLOW);
    writeFileSync(path.join(dir, "bug-fix.yaml"), text);
    const files = new PipelineFiles(dir, () => DEFAULT_CONFIG);
    const patch = (p: Record<string, unknown>) => files.patch("bug-fix", p);
    return { files, patch };
  };
  const names = (source: { pipeline: { stages: Stage[] } | null }) => source.pipeline!.stages.map((s) => s.name);

  it("carries the entries of a reusing Pipeline, and none for one that reuses nothing", () => {
    const { files } = setup();
    expect(files.read("bug-fix")!.entries!.map((e) => e.kind)).toEqual(["include", "own", "use"]);
    expect(files.read("flow")!.entries).toBeNull();
  });

  it("sets a field on an included Stage under change, and on a use entry beside use", () => {
    const { patch } = setup();
    const saved = patch({ stages: { implement: { budget: { rounds: 5 } }, review: { prompt: "Review it.", human: true } } });
    expect(saved.text).toBe(BUG_FIX.replace("        append: Write a failing test first.\n", "        append: Write a failing test first.\n        budget: { rounds: 5 }\n").replace("    skills: [ code-review ]\n", "    skills: [ code-review ]\n    prompt: Review it.\n    human: true\n"));
    expect(runner(saved.pipeline!.stages.find((s) => s.name === "implement")!).budget).toEqual({ rounds: 5, attempts: 2 });
  });

  it("replaces an append when the prompt is set, and resets a field set back to the source's value", () => {
    const { patch } = setup();
    expect(patch({ stages: { implement: { prompt: "Just do it." } } }).text).toContain("      implement:\n        prompt: Just do it.\n  # Our own check.");
    // Back to the source's prompt: the change goes, and the include with it.
    const reset = patch({ stages: { implement: { prompt: "Carry out the plan." }, review: { skills: null } } });
    expect(reset.text).toBe(BUG_FIX.replace("    change:\n      implement:\n        append: Write a failing test first.\n", "").replace("    skills: [ code-review ]\n", ""));
  });

  it("skips an included Stage left out of the order, dropping its change, and keeps a skipped one named in it", () => {
    const { patch } = setup();
    const skipped = patch({ order: ["smoke", "review"] });
    expect(names(skipped)).toEqual(["smoke", "review"]);
    expect(skipped.text).toBe(BUG_FIX.replace("  - include: flow\n    to: implement\n    skip: [ plan ]\n    change:\n      implement:\n        append: Write a failing test first.\n", ""));
    const { patch: again } = setup();
    const kept = again({ order: ["plan", "smoke", "review"] });
    expect(names(kept)).toEqual(["plan", "smoke", "review"]);
    expect(kept.text).toContain("  - include: flow\n    to: implement\n    skip: [ implement ]\n  # Our own check.");
    const { patch: third } = setup();
    expect(names(third({ order: ["plan", "implement", "smoke", "review"] }))).toEqual(["plan", "implement", "smoke", "review"]);
  });

  it("removes a use entry or an own Stage left out of the order, keeping the comments of the rest", () => {
    const { patch } = setup();
    const saved = patch({ order: ["implement", "review"] });
    expect(names(saved)).toEqual(["implement", "review"]);
    expect(saved.text).toBe(BUG_FIX.replace("  # Our own check.\n  - name: smoke\n    prompt: Run it.\n", ""));
    expect(names(patch({ order: ["implement"] }))).toEqual(["implement"]);
  });

  it("edits own Stages in place among reuse entries", () => {
    const { patch } = setup();
    expect(patch({ stages: { smoke: { prompt: "Run the app." } } }).text).toBe(BUG_FIX.replace("prompt: Run it.", "prompt: Run the app."));
    expect(() => patch({ stages: { nope: { prompt: "x" } } })).toThrow("Pipeline bug-fix has no Stage named nope");
    expect(() => patch({ order: ["implement", "implement"] })).toThrow("order names Stage implement twice");
  });
});

describe("the entry rewriter: moves and new Stages across reuse entries (LASSO-223)", () => {
  const FOUR = "stages:\n  - name: plan\n    prompt: Plan it.\n  - name: implement\n    prompt: Carry out the plan.\n  - name: test\n    prompt: Test it.\n  - name: review\n    prompt: Address feedback.\n";
  const setup = (text: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "laisso-move-"));
    writeFileSync(path.join(dir, "four.yaml"), FOUR);
    writeFileSync(path.join(dir, "bug-fix.yaml"), text);
    return (p: Record<string, unknown>) => new PipelineFiles(dir, () => DEFAULT_CONFIG).patch("bug-fix", p);
  };
  const names = (source: { pipeline: { stages: Stage[] } | null }) => source.pipeline!.stages.map((s) => s.name);
  const INCLUDE = "stages:\n  # The four-step flow.\n  - include: four\n    skip: [ test ]\n    change:\n      plan:\n        human: true\n      review:\n        append: Be kind.\n";

  it("splits an include around a Stage added inside it, each half with its own range and changes", () => {
    const patch = setup(INCLUDE.replace("    skip: [ test ]\n", ""));
    const saved = patch({ order: ["plan", "implement", { name: "triage", prompt: "Triage." }, "test", "review"] });
    expect(names(saved)).toEqual(["plan", "implement", "triage", "test", "review"]);
    expect(saved.text).toBe(
      "stages:\n  # The four-step flow.\n  - include: four\n    to: implement\n    change:\n      plan:\n        human: true\n  - name: triage\n    prompt: Triage.\n  - include: four\n    from: test\n    change:\n      review:\n        append: Be kind.\n",
    );
    expect(runner(saved.pipeline!.stages[0]!).human).toBe(true);
  });

  it("splits with skips falling in each half's own range", () => {
    const patch = setup("stages:\n  - include: four\n    skip: [ implement ]\n");
    const saved = patch({ order: ["plan", "test", { name: "x", prompt: "x" }, "review"] });
    expect(names(saved)).toEqual(["plan", "test", "x", "review"]);
    expect(saved.text).toBe("stages:\n  - include: four\n    to: test\n    skip: [ implement ]\n  - name: x\n    prompt: x\n  - use: four.review\n");
  });

  it("adds a Stage at an include's edge as an entry beside it, the include and its comment untouched", () => {
    const patch = setup(INCLUDE);
    const saved = patch({ order: [{ name: "triage", prompt: "Triage." }, "plan", "implement", "review"] });
    expect(names(saved)).toEqual(["triage", "plan", "implement", "review"]);
    expect(saved.text).toBe("stages:\n  - name: triage\n    prompt: Triage.\n" + INCLUDE.slice("stages:\n".length));
  });

  it("moves a Stage out of its include's order as a skip there and a use at its new spot, carrying its changes", () => {
    const patch = setup(INCLUDE + "  - name: smoke\n    prompt: Run it.\n");
    const saved = patch({ order: ["implement", "review", "smoke", "plan"] });
    expect(names(saved)).toEqual(["implement", "review", "smoke", "plan"]);
    expect(saved.text).toBe(
      "stages:\n  # The four-step flow.\n  - include: four\n    skip: [ plan, test ]\n    change:\n      review:\n        append: Be kind.\n  - name: smoke\n    prompt: Run it.\n  - use: four.plan\n    human: true\n",
    );
  });

  it("shifts an include's edge when its last Stage moves past the next entry", () => {
    const patch = setup("stages:\n  - include: four\n  - name: smoke\n    prompt: Run it.\n");
    const saved = patch({ order: ["plan", "implement", "test", "smoke", "review"] });
    expect(names(saved)).toEqual(["plan", "implement", "test", "smoke", "review"]);
    expect(saved.text).toBe("stages:\n  - include: four\n    to: test\n  - name: smoke\n    prompt: Run it.\n  - use: four.review\n");
    // And back: the use moves whole; separate entries are never merged.
    const back = patch({ order: ["plan", "implement", "test", "review", "smoke"] });
    expect(names(back)).toEqual(["plan", "implement", "test", "review", "smoke"]);
    expect(back.text).toBe("stages:\n  - include: four\n    to: test\n  - use: four.review\n  - name: smoke\n    prompt: Run it.\n");
  });

  it("moves own and use entries whole, and sets fields on Stages wherever they land", () => {
    const patch = setup("stages:\n  - use: four.review\n    append: Be kind.\n  # ours\n  - name: smoke\n    prompt: Run it.\n");
    const saved = patch({ order: ["smoke", "review"], stages: { review: { human: true }, smoke: { prompt: "Run the app." } } });
    expect(saved.text).toBe("stages:\n  # ours\n  - name: smoke\n    prompt: Run the app.\n  - use: four.review\n    append: Be kind.\n    human: true\n");
  });
});

describe("include: a run of another Pipeline's Stages", () => {
  const names = (files: Record<string, string>, name = "bug-fix") => load(files, name).stages.map((s) => s.name);

  it("expands to the same Stages as the source, each with its origin, and takes none of its settings", () => {
    const p = load({ "bug-fix": "stages:\n  - include: default\n" });
    const source = load({}, "default");
    expect(p.stages.map(({ from: _f, ...rest }) => rest)).toEqual(source.stages);
    expect(p.stages.every((s) => s.from?.pipeline === "default" && s.from.how === "include")).toBe(true);
    expect(p.profile).toBeNull();
    expect(load({ "bug-fix": "budget: { spend: 2 }\nstages:\n  - include: default\n" }).budget).toEqual({ spend: 2 });
  });

  it("narrows with from and to, each taking the Stage it names, and mixes with own Stages and use in order", () => {
    expect(names({ "bug-fix": "stages:\n  - include: default\n    to: implement\n  - name: smoke-test\n    prompt: s\n  - include: default\n    from: transition-in-progress\n" })).toEqual([
      "plan", "implement", "smoke-test", "transition-in-progress", "review",
    ]);
    expect(names({ "bug-fix": "stages:\n  - use: default.plan\n  - include: default\n    from: implement\n    to: implement\n" })).toEqual(["plan", "implement"]);
  });

  it("skips Stages and changes others with use's rules", () => {
    const p = load({ "bug-fix": "stages:\n  - include: default\n    skip: [ plan, transition-in-progress ]\n    change:\n      implement: { profile: codex, append: Write a failing test first., routes: { replan: null } }\n" });
    expect(p.stages.map((s) => s.name)).toEqual(["implement", "review"]);
    expect(runner(p.stages[0]!)).toMatchObject({ profile: "codex", prompt: "Carry out the plan.\n\nWrite a failing test first." });
    expect(p.stages[0]!.routes).toBeUndefined();
  });

  it("refuses names the source lacks, a change to a skipped or excluded Stage, and a bad range", () => {
    const refused = (body: string) => () => load({ "bug-fix": `stages:\n  - include: default\n${body}` });
    expect(refused("    skip: [ plan2 ]\n")).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include default): skip names plan2, which default doesn't have"));
    expect(refused("    skip: [ plan ]\n    change: { plan: { human: false } }\n")).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include default): change names plan, which this include skips"));
    expect(refused("    from: nope\n")).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include default): from names nope, which default doesn't have"));
    expect(refused("    to: nope\n")).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include default): to names nope, which default doesn't have"));
    expect(refused("    to: plan\n    change: { review: { prompt: x } }\n")).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include default): change names review, which is outside this include's from/to"));
    expect(refused("    from: review\n    to: plan\n")).toThrow(/from review comes after to plan in default/);
    expect(refused("    only: [ plan ]\n")).toThrow(/only is not a field of an include/);
    expect(() => load({ "bug-fix": "stages:\n  - include: nope\n" })).toThrow(new PipelineError("Pipeline bug-fix stage 1 (include nope): no Pipeline named nope"));
  });

  it("still resolves Routes by name across the expanded list", () => {
    expect(() => load({ "bug-fix": "stages:\n  - include: default\n    skip: [ implement ]\n" })).toThrow(
      new PipelineError("Pipeline bug-fix Stage review (from default.review): Route rework goes to implement, which is not a Stage of bug-fix"),
    );
  });

  it("lists the entries as written, with a row per Stage in range and skipped rows in place", () => {
    const { pipeline, entries } = resolveEntries("bug-fix", texts({ default: DEFAULT, "bug-fix": "stages:\n  - include: default\n    to: transition-in-progress\n    skip: [ plan ]\n    change: { implement: { profile: codex, routes: { replan: null } } }\n  - name: smoke\n    prompt: s\n  - use: default.review\n    routes: { rework: null }\n" }));
    expect(pipeline.stages.map((s) => s.name)).toEqual(["implement", "transition-in-progress", "smoke", "review"]);
    expect(entries.map((e) => e.kind)).toEqual(["include", "own", "use"]);
    const include = entries[0]!;
    if (include.kind !== "include") throw new Error("not an include");
    expect(include).toMatchObject({ index: 0, source: "default", from: null, to: "transition-in-progress" });
    expect(include.rows.map((r) => [r.name, r.stage?.name ?? null, r.changes])).toEqual([
      ["plan", null, {}],
      ["implement", "implement", { profile: "codex", routes: { replan: null } }],
      ["transition-in-progress", "transition-in-progress", {}],
    ]);
    expect(runner(include.rows[1]!.original).profile).toBeNull();
    expect(entries[2]).toMatchObject({ kind: "use", source: "default", overrides: { routes: { rework: null } } });
  });
});

describe("intake: false", () => {
  it("keeps a Pipeline as parts, still loadable and reusable; other values are refused", () => {
    const parts = "intake: false\nstages:\n  - name: review\n    prompt: r\n";
    expect(load({ parts }, "parts").intake).toBe(false);
    expect("intake" in load({}, "default")).toBe(false);
    expect(load({ parts: parts.replace("false", "true") }, "parts").intake).toBeUndefined();
    expect(load({ parts, "bug-fix": "stages:\n  - use: parts.review\n" }).intake).toBeUndefined();
    expect(() => load({ parts: parts.replace("false", "sometimes") }, "parts")).toThrow(new PipelineError("Pipeline parts: intake must be true or false"));
  });
});

describe("Intake detection with a Pipeline that does not load", () => {
  it("lists it but never suggests it, not even as a repo's default", () => {
    const config = { ...DEFAULT_CONFIG, repos: { app: { path: "/a", tracker: "jira" as const, project: "APP", pipeline: "bug-fix", actions: {}, profiles: {}, default_profile: null } } };
    const d = detect(config, "Fix it", ["bug-fix", "default"], "app", ["bug-fix"]);
    expect(d.pipeline).toEqual({ suggestion: "default", choices: ["bug-fix", "default"], byRepo: { app: "default" } });
  });
});
