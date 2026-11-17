import { isMap, isSeq, type Document } from "yaml";
import { isPlainObject } from "../fields.ts";
import { defaultActionName, PipelineError, type Entry, type Stage } from "./load.ts";
import { rawStage } from "./reuse.ts";

/**
 * Entry rewriter (LASSO-222): edits made to a reusing Pipeline's expanded
 * Stage list, written back into its stages as written. A field set on a
 * copied Stage becomes an override (onto the `use` entry, or under the
 * include's `change.<stage>`); an override equal to the source's value is
 * dropped, so setting a field back is how it resets. Leaving a Stage out
 * skips it in its include, or removes its `use` or own entry; naming a
 * skipped Stage keeps it again.
 */

/** One line of the editor's list: every Stage the entries expand to, and each one an include skips, in place. */
export interface Row {
  /** Its name in this Pipeline: as expanded, or the source's name for a skipped one. */
  name: string;
  /** Which entry of `stages` it comes from. */
  entry: number;
  how: "own" | "use" | "include";
  /** The Pipeline a copied Stage comes from; null for an own Stage. */
  source: string | null;
  /** The Stage as this Pipeline has it; for a skipped one, the source's. */
  stage: Stage;
  /** The source Stage a copied one was made from; null for an own Stage. */
  original: Stage | null;
  skipped: boolean;
}

export function rowsOf(entries: Entry[]): Row[] {
  return entries.flatMap((e): Row[] => {
    if (e.kind === "own") return [{ name: e.stage.name, entry: e.index, how: "own", source: null, stage: e.stage, original: null, skipped: false }];
    if (e.kind === "use") return [{ name: e.stage.name, entry: e.index, how: "use", source: e.source, stage: e.stage, original: e.original, skipped: false }];
    return e.rows.map((r) => ({ name: r.stage?.name ?? r.name, entry: e.index, how: "include", source: e.source, stage: r.stage ?? r.original, original: r.original, skipped: r.stage === null }));
  });
}

/** What a reusing Pipeline's patch asks of its Stages: fields by expanded name, and the order the kept ones run in. */
export interface StagesEdit {
  stages?: Record<string, unknown>;
  order?: unknown;
}

/** Applies an own Stage's fields at its entry, as an own-only Pipeline's patch does. */
export type ApplyOwn = (doc: Document, index: number, fields: Record<string, unknown>) => void;

export function rewriteEntries(doc: Document, pipeline: string, entries: Entry[], edit: StagesEdit, applyOwn: ApplyOwn): void {
  const rows = rowsOf(entries);
  const fail = (message: string) => new PipelineError(`Pipeline ${pipeline}: ${message}`);
  const wanted = edit.order === undefined ? new Set(rows.filter((r) => !r.skipped).map((r) => r.name)) : orderOf(rows, edit.order, fail);
  const gone = new Set<number>();

  // Keep before setting fields, so a kept Stage's change can be written.
  for (const row of rows) if (row.skipped && wanted.has(row.name)) setSkip(doc, row, false);

  for (const [name, fields] of Object.entries(edit.stages ?? {})) {
    const row = rows.find((r) => r.name === name && wanted.has(r.name));
    if (!row) throw new PipelineError(`Pipeline ${pipeline} has no Stage named ${name}`);
    if (!isPlainObject(fields)) throw new PipelineError(`Stage ${name}: fields must be a mapping`);
    if (row.how === "own") applyOwn(doc, row.entry, fields);
    else setOverrides(doc, overridePath(row), row.original!, fields, row.how === "use" ? ["use"] : []);
  }

  for (const row of rows) {
    if (row.skipped || wanted.has(row.name)) continue;
    if (row.how === "include") setSkip(doc, row, true);
    else gone.add(row.entry);
  }
  // An include left with nothing to take goes whole.
  for (const e of entries) {
    if (e.kind !== "include") continue;
    const kept = rows.filter((r) => r.entry === e.index && wanted.has(r.name));
    if (!kept.length) gone.add(e.index);
  }
  const seq = doc.get("stages", true);
  if (!isSeq(seq)) throw fail("stages is not a list");
  if (gone.size === seq.items.length) throw new PipelineError(`Pipeline ${pipeline} must keep at least one Stage`);
  for (const index of [...gone].sort((a, b) => b - a)) seq.items.splice(index, 1);
}

/** The names `order` keeps. Until moves across entries land (LASSO-223), it may only leave Stages out or keep skipped ones, in place. */
function orderOf(rows: Row[], order: unknown, fail: (message: string) => Error): Set<string> {
  if (!Array.isArray(order)) throw new PipelineError("order must be a list of Stage names and new Stages");
  if (order.some((x) => typeof x !== "string")) throw fail("new Stages go in by text for now; it reuses Stages from other Pipelines");
  const names = order as string[];
  if (names.length === 0) throw fail("a Pipeline must keep at least one Stage");
  let at = -1;
  for (const name of names) {
    const i = rows.findIndex((r) => r.name === name);
    if (i < 0) throw fail(`no Stage named ${name}`);
    if (i <= at) throw fail(`Stages move by text for now; it reuses Stages from other Pipelines (${name})`);
    at = i;
  }
  return new Set(names);
}

/** Where a copied Stage's overrides live: on its `use` entry, or under its include's `change.<stage>`. */
function overridePath(row: Row): Array<string | number> {
  return row.how === "use" ? ["stages", row.entry] : ["stages", row.entry, "change", row.original!.name];
}

/** Add or take a source Stage's name from its include's `skip`; a skipped Stage's change goes with it, as an include allows none. */
function setSkip(doc: Document, row: Row, skip: boolean): void {
  const at = ["stages", row.entry];
  const list = doc.getIn([...at, "skip"], true);
  const names = (isSeq(list) ? (list.toJSON() as string[]) : []).filter((n) => n !== row.original!.name);
  if (skip) {
    names.push(row.original!.name);
    doc.deleteIn([...at, "change", row.original!.name]);
    dropEmpty(doc, [...at, "change"]);
  }
  if (!names.length) doc.deleteIn([...at, "skip"]);
  else {
    const node = doc.createNode(names);
    node.flow = true;
    doc.setIn([...at, "skip"], node);
  }
}

const MAPS = new Set(["budget", "with", "routes"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Lay `fields` (the editor's changes to the expanded Stage, null clearing a key) onto the overrides at `at`, then
 * drop every override the source already has, so the entry says only what differs. `keep` names keys at `at` that are
 * not overrides (a `use` entry's own key).
 */
function setOverrides(doc: Document, at: Array<string | number>, original: Stage, fields: Record<string, unknown>, keep: string[]): void {
  const node = doc.getIn(at, true);
  const current: Record<string, unknown> = isMap(node) ? (node.toJSON() as Record<string, unknown>) : {};
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(current).filter(([k]) => !keep.includes(k)));
  const source = rawStage(original, defaultActionName);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "prompt") delete next.append;
    if (MAPS.has(key) && isPlainObject(value)) {
      const map = { ...(isPlainObject(next[key]) ? (next[key] as Record<string, unknown>) : {}) };
      for (const [k, v] of Object.entries(value)) map[k] = v;
      next[key] = map;
    } else next[key] = value;
  }
  // What the source already says needs no override; null over nothing is nothing.
  const redundant = (value: unknown, was: unknown) => same(value, was) || (value === null && was === undefined);
  for (const key of Object.keys(next)) {
    if (key === "append") continue;
    const was = source[key];
    if (MAPS.has(key) && isPlainObject(next[key])) {
      const map = next[key] as Record<string, unknown>;
      const wasMap = isPlainObject(was) ? (was as Record<string, unknown>) : {};
      for (const k of Object.keys(map)) if (redundant(map[k], wasMap[k])) delete map[k];
      if (!Object.keys(map).length) delete next[key];
    } else if (redundant(next[key], was)) delete next[key];
  }
  for (const key of Object.keys(current)) if (!keep.includes(key) && !(key in next)) doc.deleteIn([...at, key]);
  for (const [key, value] of Object.entries(next)) {
    if (same(value, current[key])) continue;
    const created = doc.createNode(value);
    if (key === "with" || key === "budget" || Array.isArray(value)) (created as { flow?: boolean }).flow = true;
    doc.setIn([...at, key], created);
  }
  if (!keep.length) {
    dropEmpty(doc, at);
    dropEmpty(doc, at.slice(0, -1));
  }
}

function dropEmpty(doc: Document, at: Array<string | number>): void {
  const node = doc.getIn(at, true);
  if (isMap(node) && node.items.length === 0) doc.deleteIn(at);
}
