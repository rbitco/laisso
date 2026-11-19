import { describe, it, expect } from "vitest";
import { breakage, brokenLine, reusers, WouldBreak } from "../src/pipeline/impact.ts";
import type { ReadPipeline } from "../src/pipeline/load.ts";

// Reuse impact, breakage (LASSO-219): which Pipelines a change to another would stop loading.
const texts =
  (files: Record<string, string>): ReadPipeline =>
  (name) =>
    files[name] ?? null;

const DEFAULT = "stages:\n  - name: plan\n    prompt: p\n  - name: implement\n    prompt: i\n";
const FILES = {
  default: DEFAULT,
  "bug-fix": "stages:\n  - use: default.plan\n  - use: default.implement\n",
  hotfix: "stages:\n  - use: bug-fix.implement\n",
  solo: "stages:\n  - name: x\n    prompt: x\n",
  broken: "stages:\n  - use: default.nope\n",
};
const NAMES = Object.keys(FILES);
const after = (text: string | null, name = "default") => breakage(texts(FILES), NAMES, name, text);

describe("breakage", () => {
  it("names each Pipeline a source edit stops loading, through a chain too", () => {
    expect(after(DEFAULT.replace("name: implement", "name: build"))).toEqual([
      { pipeline: "bug-fix", problem: "Pipeline bug-fix stage 2 (use default.implement): default has no Stage named implement" },
      { pipeline: "hotfix", problem: "Pipeline hotfix stage 1 (use bug-fix.implement): bug-fix does not load" },
    ]);
  });

  it("names those that reuse a deleted source", () => {
    expect(after(null).map((b) => b.pipeline)).toEqual(["bug-fix", "hotfix"]);
    expect(after(null)[0]!.problem).toBe("Pipeline bug-fix stage 1 (use default.plan): no Pipeline named default");
  });

  it("is empty for a change that breaks nothing, and ignores Pipelines already broken", () => {
    expect(after(DEFAULT.replace("prompt: p", "prompt: better"))).toEqual([]);
    expect(after(null, "solo")).toEqual([]);
  });

  it("words the refusal with each broken Pipeline led by its name", () => {
    const error = new WouldBreak("Saving", "default", after(DEFAULT.replace("name: implement", "name: build")).slice(0, 1));
    expect(error.message).toBe("Saving default breaks 1 Pipeline: bug-fix: stage 2 (use default.implement): default has no Stage named implement");
    expect(brokenLine({ pipeline: "a", problem: "Pipeline a: reuse loop a → b → a" })).toBe("a: reuse loop a → b → a");
  });
});

describe("reusers", () => {
  const SOURCE = "stages:\n  - name: plan\n    prompt: p\n  - name: implement\n    prompt: i\n  - name: review\n    prompt: r\n";
  const files = {
    default: SOURCE,
    "bug-fix": "stages:\n  - include: default\n    to: implement\n    skip: [ plan ]\n",
    "codex-review": "stages:\n  - use: default.review\n    name: check\n",
    hotfix: "stages:\n  - use: bug-fix.implement\n",
    solo: "stages:\n  - name: x\n    prompt: x\n",
    broken: "stages:\n  - use: default.nope\n",
  };
  const of = (source: string) => reusers(texts(files), Object.keys(files), source);

  it("names each Pipeline that takes Stages from a source, by use, by include within from/to and skip, and through a chain", () => {
    expect(of("default")).toEqual([
      { pipeline: "bug-fix", stages: ["implement"] },
      { pipeline: "codex-review", stages: ["review"] },
      { pipeline: "hotfix", stages: ["implement"] },
    ]);
    expect(of("bug-fix")).toEqual([{ pipeline: "hotfix", stages: ["implement"] }]);
  });

  it("is empty for a Pipeline nothing reuses", () => {
    expect(of("solo")).toEqual([]);
    expect(of("hotfix")).toEqual([]);
  });
});
