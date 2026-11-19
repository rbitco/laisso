import { overlay, PipelineError, resolvePipeline, type Pipeline, type ReadPipeline, type Stage } from "./load.ts";

/** A Pipeline that loads now and would not after a change, and what it would say. */
export interface Broken {
  pipeline: string;
  problem: string;
}

/**
 * Reuse impact, breakage (LASSO-219): which of `names`, other than the one
 * changed, load now but would not with `name`'s text replaced by `text` (null
 * deletes it). A chain counts: a Pipeline that reuses one this change breaks
 * stops loading too.
 */
export function breakage(read: ReadPipeline, names: string[], name: string, text: string | null): Broken[] {
  const after = overlay(read, name, text);
  return names.flatMap((other) => {
    if (other === name || !loads(other, read)) return [];
    try {
      resolvePipeline(other, after);
      return [];
    } catch (error) {
      if (!(error instanceof PipelineError)) throw error;
      return [{ pipeline: other, problem: error.message }];
    }
  });
}

function loads(name: string, read: ReadPipeline): boolean {
  try {
    resolvePipeline(name, read);
    return true;
  } catch (error) {
    if (error instanceof PipelineError) return false;
    throw error;
  }
}

/** A save or delete refused because it would stop other Pipelines loading; sent again with confirm, it goes ahead. */
export class WouldBreak extends PipelineError {
  readonly breaks: Broken[];
  constructor(verb: "Saving" | "Deleting", name: string, breaks: Broken[]) {
    const n = breaks.length;
    super(`${verb} ${name} breaks ${n} Pipeline${n === 1 ? "" : "s"}: ${breaks.map(brokenLine).join("; ")}`);
    this.breaks = breaks;
  }
}

/** `bug-fix: stage 3 (use default.implement): ...`, the loader's message led by the Pipeline's name. */
export function brokenLine(b: Broken): string {
  const lead = `Pipeline ${b.pipeline}`;
  if (!b.problem.startsWith(lead)) return `${b.pipeline}: ${b.problem}`;
  const rest = b.problem.slice(lead.length).replace(/^:?\s*/, "");
  return `${b.pipeline}: ${rest}`;
}

/** A Pipeline that takes Stages from a source, and which of the source's Stages, by their names there. */
export interface Reuser {
  pipeline: string;
  stages: string[];
}

/**
 * Reuse impact, reusers (LASSO-220): the Pipelines that take Stages from
 * `source`, directly or through a chain (a `use` of a Stage that was itself
 * copied from it), each with the source Stages it takes. Pipelines that do
 * not load are left out: they take nothing until fixed.
 */
export function reusers(read: ReadPipeline, names: string[], source: string): Reuser[] {
  const loaded = new Map<string, Pipeline>();
  for (const name of names) {
    try {
      loaded.set(name, resolvePipeline(name, read));
    } catch (error) {
      if (!(error instanceof PipelineError)) throw error;
    }
  }
  /** The source Stage a Stage came from, followed back through each Pipeline it was copied via. */
  const takes = (stage: Stage, seen: Set<string>): string | null => {
    const from = stage.from;
    if (!from) return null;
    if (from.pipeline === source) return from.stage;
    const key = `${from.pipeline}.${from.stage}`;
    const upstream = loaded.get(from.pipeline)?.stages.find((s) => s.name === from.stage);
    if (!upstream || seen.has(key)) return null;
    return takes(upstream, new Set([...seen, key]));
  };
  return names.flatMap((name) => {
    const pipeline = loaded.get(name);
    if (name === source || !pipeline) return [];
    const stages = [...new Set(pipeline.stages.flatMap((s) => takes(s, new Set()) ?? []))];
    return stages.length ? [{ pipeline: name, stages }] : [];
  });
}
