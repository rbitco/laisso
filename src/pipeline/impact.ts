import { overlay, PipelineError, resolvePipeline, type ReadPipeline } from "./load.ts";

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
