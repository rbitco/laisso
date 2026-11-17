import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";
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
 * skipped Stage keeps it again; and the entries are rebuilt to give the
 * order shown, new Stages included.
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

/** What a reusing Pipeline's patch asks of its Stages: fields by expanded name, and the order they run in, new Stages as mappings. */
export interface StagesEdit {
  stages?: Record<string, unknown>;
  order?: unknown;
}

/** How the caller writes own Stages: their fields at an entry, and a new Stage's node, as an own-only Pipeline's patch does. */
export interface OwnStages {
  apply: (doc: Document, index: number, fields: Record<string, unknown>) => void;
  create: (doc: Document, fields: Record<string, unknown>) => Node;
}

/** One entry of the stages as rewritten: a node kept or made, and the rows it now holds. */
type Out = { node: Node; rows: Row[]; how: Row["how"] };

/**
 * Write `edit` into the stages of `doc`. The entries are rebuilt to give the order shown (LASSO-223): consecutive
 * Stages of one include, in their source's order, stay one include, skipping whatever between them went elsewhere;
 * where an include splits around other Stages, each run becomes an include with its own from/to, skips and changes;
 * a range of a single Stage (one moved out of its include's order, say) becomes `use`, carrying its changes. Own and `use` entries move whole, comments and all.
 */
export function rewriteEntries(doc: Document, pipeline: string, entries: Entry[], edit: StagesEdit, own: OwnStages): void {
  const rows = rowsOf(entries);
  const fail = (message: string) => new PipelineError(`Pipeline ${pipeline}: ${message}`);
  const order: Array<Row | Record<string, unknown>> = edit.order === undefined ? rows.filter((r) => !r.skipped) : orderOf(rows, edit.order, fail);
  if (!order.length) throw new PipelineError(`Pipeline ${pipeline} must keep at least one Stage`);
  const seq = doc.get("stages", true);
  if (!isSeq(seq)) throw fail("stages is not a list");
  const nodes = seq.items as Node[];
  const includes = new Map(entries.flatMap((e) => (e.kind === "include" ? [[e.index, e] as const] : [])));
  const pos = (row: Row) => includes.get(row.entry)!.rows.findIndex((r) => r.name === row.original!.name);

  // Runs: consecutive rows of one include in its source's order.
  const runs: Array<Row[] | Row | Record<string, unknown>> = [];
  for (const item of order) {
    const last = runs.at(-1);
    if (isRow(item) && item.how === "include") {
      if (Array.isArray(last) && last[0]!.entry === item.entry && pos(item) > pos(last.at(-1)!)) last.push(item);
      else runs.push([item]);
    } else runs.push(item);
  }
  // A run is in order when it lies past every earlier in-order run of its include; one that does not is a move.
  const inOrder = new Set<Row[]>();
  const reach = new Map<number, number>();
  for (const run of runs) {
    if (!Array.isArray(run)) continue;
    const entry = run[0]!.entry;
    if (pos(run[0]!) > (reach.get(entry) ?? -1)) {
      inOrder.add(run);
      reach.set(entry, pos(run.at(-1)!));
    }
  }
  const out: Out[] = [];
  const reused = new Set<number>();
  for (const run of runs) {
    if (!Array.isArray(run)) {
      if (!isRow(run)) out.push({ node: own.create(doc, run), rows: [], how: "own" });
      else out.push({ node: nodes[run.entry]!, rows: [run], how: run.how });
      continue;
    }
    const e = includes.get(run[0]!.entry)!;
    const changes = (row: Row) => e.rows[pos(row)]!.changes;
    const ordered = inOrder.has(run);
    // An in-order run reaches the include's own edge unless another in-order run lies past it; a moved one spans itself.
    const first = pos(run[0]!);
    const last = pos(run.at(-1)!);
    const others = [...inOrder].filter((r) => r !== run && r[0]!.entry === e.index);
    const before = !ordered || others.some((r) => pos(r[0]!) < first);
    const after = !ordered || others.some((r) => pos(r[0]!) > last);
    const lo = before ? first : 0;
    const hi = after ? last : e.rows.length - 1;
    // A range of one Stage is a `use`.
    if (lo === hi) {
      const row = run[0]!;
      out.push({ node: doc.createNode({ use: `${e.source}.${row.original!.name}`, ...changes(row) }) as Node, rows: run, how: "use" });
      continue;
    }
    const fields: Record<string, unknown> = { include: e.source };
    const from = before ? e.rows[first]!.name : e.from;
    const to = after ? e.rows[last]!.name : e.to;
    if (from !== null) fields.from = from;
    if (to !== null) fields.to = to;
    const taken = new Set(run.map((r) => r.original!.name));
    const skip = e.rows.slice(lo, hi + 1).filter((r) => !taken.has(r.name)).map((r) => r.name);
    if (skip.length) fields.skip = skip;
    const change = Object.fromEntries(run.flatMap((r) => (Object.keys(changes(r)).length ? [[r.original!.name, changes(r)]] : [])));
    if (Object.keys(change).length) fields.change = change;
    // The include's first run keeps its node, and so its comments; any other is made afresh.
    const keep = !reused.has(e.index);
    reused.add(e.index);
    out.push({ node: keep ? reshape(doc, nodes[e.index]!, fields) : flowSkip(doc.createNode(fields) as Node), rows: run, how: "include" });
  }

  // The first Stage's comment sits on the list itself, so it is handed to the Stage and back.
  if (seq.commentBefore) {
    (nodes[0] as { commentBefore?: string }).commentBefore = seq.commentBefore;
    seq.commentBefore = undefined;
  }
  const spaced = nodes.slice(1).some((n) => (n as { spaceBefore?: boolean }).spaceBefore);
  out.forEach(({ node }, i) => ((node as { spaceBefore?: boolean }).spaceBefore = i > 0 && spaced));
  const head = out[0]!.node as { commentBefore?: string };
  if (head.commentBefore) {
    seq.commentBefore = head.commentBefore;
    head.commentBefore = undefined;
  }
  seq.items = out.map((o) => o.node) as typeof seq.items;

  for (const [name, fields] of Object.entries(edit.stages ?? {})) {
    const at = out.findIndex((o) => o.rows.some((r) => r.name === name));
    if (at < 0) throw new PipelineError(`Pipeline ${pipeline} has no Stage named ${name}`);
    if (!isPlainObject(fields)) throw new PipelineError(`Stage ${name}: fields must be a mapping`);
    const row = out[at]!.rows.find((r) => r.name === name)!;
    const how = out[at]!.how;
    if (how === "own") own.apply(doc, at, fields);
    else if (how === "use") setOverrides(doc, ["stages", at], row.original!, fields, ["use"]);
    else setOverrides(doc, ["stages", at, "change", row.original!.name], row.original!, fields, []);
  }
}

const isRow = (item: unknown): item is Row => typeof item === "object" && item !== null && "entry" in item && "how" in item && "original" in item;

/** The rows `order` names and the new Stages it holds, in its order. */
function orderOf(rows: Row[], order: unknown, fail: (message: string) => Error): Array<Row | Record<string, unknown>> {
  if (!Array.isArray(order) || !order.every((x) => typeof x === "string" || isPlainObject(x))) throw new PipelineError("order must be a list of Stage names and new Stages");
  const seen = new Set<string>();
  return order.map((item) => {
    if (typeof item !== "string") return Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== null));
    const row = rows.find((r) => r.name === item);
    if (!row) throw fail(`no Stage named ${item}`);
    if (seen.has(item)) throw new PipelineError(`order names Stage ${item} twice`);
    seen.add(item);
    return row;
  });
}

/** An include's own node set to `fields`, each key left alone where it already says the same, so its comments stay. */
function reshape(doc: Document, node: Node, fields: Record<string, unknown>): Node {
  if (!isMap(node)) return node;
  const was = node.toJSON() as Record<string, unknown>;
  for (const key of Object.keys(was)) if (!(key in fields)) node.delete(key);
  for (const [key, value] of Object.entries(fields)) {
    if (same(value, was[key])) continue;
    if (key === "change" && isPlainObject(was.change)) {
      // Drop the changes of Stages it no longer takes; the rest are as they were.
      const change = node.get("change", true);
      if (isMap(change)) for (const stage of Object.keys(was.change as object)) if (!(stage in (value as object))) change.delete(stage);
      continue;
    }
    const created = doc.createNode(value) as Node;
    if (key === "skip") (created as { flow?: boolean }).flow = true;
    node.set(key, created);
  }
  const rank = (item: { key: unknown }) => INCLUDE_ORDER.indexOf(String(isScalar(item.key) ? item.key.value : item.key));
  node.items.sort((a, b) => rank(a) - rank(b));
  return node;
}

const INCLUDE_ORDER = ["include", "from", "to", "skip", "change"];

function flowSkip(node: Node): Node {
  const skip = isMap(node) ? node.get("skip", true) : null;
  if (isSeq(skip)) skip.flow = true;
  return node;
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
