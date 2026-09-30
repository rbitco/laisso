import { readFileSync, unlinkSync } from "node:fs";
import { replaceFile } from "../atomic-write.ts";
import path from "node:path";
import { parseDocument, isSeq, type Document } from "yaml";
import { applyPatch } from "../yaml-edit.ts";
import { isPlainObject } from "../fields.ts";
import { checkActions, parsePipeline, pipelineFile, listPipelines, PipelineError, NAME, type Pipeline } from "./load.ts";
import type { ActionConfig } from "../server/config.ts";

/** A Pipeline file as read: the text as written, and what it parses to or why it does not. */
export interface PipelineSource {
  name: string;
  file: string;
  text: string;
  pipeline: Pipeline | null;
  problem: string | null;
}

/**
 * A structured edit of a Pipeline file (spec: the dashboard edits Pipeline
 * files in place). Stages are keyed by their name before the edit; null
 * clears a field. `order` lists those names as the Stages should now run: a
 * Stage left out is removed, and a mapping in the list is a new Stage's
 * fields. The result must still parse, or nothing is written.
 */
export interface PipelinePatch {
  runner?: string | null;
  budget?: Record<string, unknown> | null;
  stages?: Record<string, Record<string, unknown>>;
  order?: Array<string | Record<string, unknown>>;
}

/** The Pipeline files under the Lasso home, edited in place with their comments kept. */
export class PipelineFiles {
  private dir: string;
  private actions: () => Record<string, ActionConfig>;

  /** `actions` are config's, read at each save so an edit to config.yaml counts at once. */
  constructor(dir: string, actions: () => Record<string, ActionConfig>) {
    this.dir = dir;
    this.actions = actions;
  }

  list(): PipelineSource[] {
    return listPipelines(this.dir).flatMap((name) => {
      const file = pipelineFile(this.dir, name);
      return file ? [sourceOf(name, file, readFileSync(file, "utf8"))] : [];
    });
  }

  /** The Pipeline of that name, or null; a name that could not be a Pipeline's (such as a path) is nobody's. */
  read(name: string): PipelineSource | null {
    const file = NAME.test(name) ? pipelineFile(this.dir, name) : null;
    if (!file) return null;
    return sourceOf(name, file, readFileSync(file, "utf8"));
  }

  /** Create or replace the whole file; the text must parse first. With `create`, an existing Pipeline is left alone. */
  write(name: string, text: unknown, opts: { create?: boolean } = {}): PipelineSource {
    checkName(name);
    if (typeof text !== "string") throw new PipelineError("text must be the whole Pipeline file");
    checkActions(parsePipeline(name, text), this.actions());
    const existing = pipelineFile(this.dir, name);
    if (existing && opts.create) throw new PipelineError(`Pipeline ${name} already exists`);
    const file = existing ?? path.join(this.dir, `${name}.yaml`);
    replaceFile(file, text);
    return sourceOf(name, file, text);
  }

  patch(name: string, patch: unknown): PipelineSource {
    const current = this.read(name);
    if (!current) throw new PipelineError(`Pipeline ${name} does not exist under ${this.dir}`);
    if (!isPlainObject(patch)) throw new PipelineError("patch must be a mapping");
    if (!current.pipeline) throw new PipelineError(`Pipeline ${name} cannot be patched until it loads (${current.problem}); replace its text instead`);
    const doc = parseDocument(current.text);
    const { stages, order, ...rest } = patch;
    applyPatch(doc, rest);
    if (stages !== undefined) {
      if (!isPlainObject(stages)) throw new PipelineError("stages must be a mapping of Stage name to fields");
      for (const [stageName, fields] of Object.entries(stages)) {
        const index = current.pipeline.stages.findIndex((s) => s.name === stageName);
        if (index < 0) throw new PipelineError(`Pipeline ${name} has no Stage named ${stageName}`);
        if (!isPlainObject(fields)) throw new PipelineError(`Stage ${stageName}: fields must be a mapping`);
        applyPatch(doc, fields, ["stages", index]);
      }
    }
    if (order !== undefined) reorderStages(doc, name, current.pipeline.stages.map((s) => s.name), order);
    const text = doc.toString();
    checkActions(parsePipeline(name, text), this.actions());
    replaceFile(current.file, text);
    return sourceOf(name, current.file, text);
  }

  remove(name: string): boolean {
    const file = NAME.test(name) ? pipelineFile(this.dir, name) : null;
    if (!file) return false;
    unlinkSync(file);
    return true;
  }
}

/**
 * Rearrange the stages list to `order`, dropping the Stages it leaves out and
 * adding a new Stage for each mapping (its null fields left out). Each Stage
 * keeps the comments above and beside it; the first Stage's comment sits on
 * the list itself, so it is handed to the Stage and back.
 */
function reorderStages(doc: Document, pipeline: string, names: string[], order: unknown): void {
  if (!Array.isArray(order) || !order.every((x) => typeof x === "string" || isPlainObject(x))) throw new PipelineError("order must be a list of Stage names and new Stages");
  if (order.length === 0) throw new PipelineError(`Pipeline ${pipeline} must keep at least one Stage`);
  const seen = new Set<string>();
  for (const stageName of order) {
    if (typeof stageName !== "string") continue;
    if (!names.includes(stageName)) throw new PipelineError(`Pipeline ${pipeline} has no Stage named ${stageName}`);
    if (seen.has(stageName)) throw new PipelineError(`order names Stage ${stageName} twice`);
    seen.add(stageName);
  }
  const seq = doc.get("stages", true);
  if (!isSeq(seq)) throw new PipelineError(`Pipeline ${pipeline}: stages is not a list`);
  const items = seq.items as Array<{ commentBefore?: string | null; spaceBefore?: boolean }>;
  if (seq.commentBefore) {
    items[0]!.commentBefore = seq.commentBefore;
    seq.commentBefore = undefined;
  }
  const spaced = items.slice(1).some((n) => n.spaceBefore);
  const next = order.map((entry) => (typeof entry === "string" ? items[names.indexOf(entry)]! : (newStage(doc, entry) as (typeof items)[number])));
  next.forEach((n, i) => (n.spaceBefore = i > 0 && spaced));
  if (next[0]!.commentBefore) {
    seq.commentBefore = next[0]!.commentBefore;
    next[0]!.commentBefore = undefined;
  }
  seq.items = next as typeof seq.items;
}

/** A new Stage's node: null fields left out, lists written inline as the default Pipeline writes them. */
function newStage(doc: Document, fields: Record<string, unknown>) {
  const node = doc.createNode(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)));
  for (const pair of node.items) if (isSeq(pair.value)) pair.value.flow = true;
  return node;
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new PipelineError("Pipeline name must be lowercase letters, digits, and hyphens");
}

function sourceOf(name: string, file: string, text: string): PipelineSource {
  try {
    return { name, file, text, pipeline: parsePipeline(name, text), problem: null };
  } catch (error) {
    return { name, file, text, pipeline: null, problem: error instanceof Error ? error.message : String(error) };
  }
}
