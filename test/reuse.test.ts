import { describe, it, expect } from "vitest";
import { resolvePipeline, overlay, PipelineError, type ReadPipeline } from "../src/pipeline/load.ts";

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
