import type { ActionListing, PipelineView, StageFields } from "../../../api/views.ts";
import type { PipelinePatch } from "../../../pipeline/files.ts";

type RunnerFields = Extract<StageFields, { kind: "runner" }>;
type ActionFields = Extract<StageFields, { kind: "action" }>;

/** A Runner Stage as typed: each text field its raw string, each checkbox as ticked, and the profile its button chose. */
export interface RunnerDraft {
  kind: "runner";
  name: string;
  prompt: string;
  skills: string;
  profile: string | null;
  /** The Artifact picked: blank for none, a built-in's name, `file`, or `action <name>`. */
  artifact: string;
  /** A `file` Artifact's path. */
  artifactPath: string;
  /** A check Action's params as typed, kept when another Action is picked. */
  artifactWith: Record<string, string>;
  human: boolean;
  advance: boolean;
  repeat: boolean;
  rounds: string;
  attempts: string;
  wallTime: string;
}

/** An Action Stage as typed: the Action picked, and every param typed so far, kept when another Action is picked. */
export interface ActionDraft {
  kind: "action";
  action: string;
  with: Record<string, string>;
}

export type StageDraft = RunnerDraft | ActionDraft;

/** One Stage card: the Stage it started as, what it holds now, and whether it is new, removed on Save, or open. */
export interface Card {
  id: number;
  stage: StageFields;
  draft: StageDraft;
  fresh: boolean;
  removed: boolean;
  open: boolean;
}

/** The Pipeline editor as typed: its settings, and its Stages in the order they will be saved. */
export interface PipelineDraft {
  /** The profile dropdown; blank leaves the Stages to default_profile. */
  profile: string;
  spend: string;
  cards: Card[];
}

/** Each configured Action's params, by name. */
export type Params = Record<string, string[]>;

/** What a new Stage starts as: every field at its default. */
export const BLANK_STAGE: RunnerFields = { kind: "runner", name: "", label: "", prompt: null, skills: [], profile: null, human: false, advance: true, artifact: null, repeat: null, budget: {} };
export const BLANK_ACTION: ActionFields = { kind: "action", name: "", label: "", action: "", with: {} };

/** A field that does not hold what it must; nothing is sent until it does. `stage` is its card's place, null for the Pipeline's. */
export class FieldError extends Error {
  readonly stage: number | null;
  readonly field: string;

  constructor(stage: number | null, field: string, message: string) {
    super(message);
    this.stage = stage;
    this.field = field;
  }
}

/** Each configured Action's params, by name; a global one stands ahead of a repo's own of the same name. */
export function paramsOf(actions: ActionListing[]): Params {
  const params: Params = {};
  for (const a of actions) params[a.name] ??= a.params;
  return params;
}

/** The params a check Action Artifact shows: config's, or for the Action the Stage was saved with and config lacks, its own. */
export function artifactKeys(stage: RunnerFields, artifact: string, params: Params): string[] {
  const action = checkAction(artifact);
  if (action === null) return [];
  return params[action] ?? (artifact === stage.artifact ? Object.keys(stage.artifactWith ?? {}) : []);
}

/** The Action an `action <name>` Artifact names, or null. */
export function checkAction(artifact: string): string | null {
  return /^action\s+(\S+)$/.exec(artifact)?.[1] ?? null;
}

/** The params an Action Stage shows for `action`: config's, or for the Action the Stage was saved with and config lacks, its own. */
export function actionKeys(stage: ActionFields, action: string, params: Params): string[] {
  return params[action] ?? (action === stage.action ? Object.keys(stage.with) : []);
}

export function stageDraft(s: StageFields): StageDraft {
  if (s.kind === "action") return { kind: "action", action: s.action, with: { ...s.with } };
  const text = (v: number | string | undefined) => (v === undefined ? "" : String(v));
  return {
    kind: "runner",
    name: s.name,
    prompt: s.prompt ?? "",
    skills: s.skills.join(", "),
    profile: s.profile,
    ...artifactDraft(s),
    human: s.human,
    advance: s.advance,
    repeat: s.repeat === "feedback",
    rounds: text(s.budget.rounds),
    attempts: text(s.budget.attempts),
    wallTime: s.budget.wallTime ?? "",
  };
}

// A `file <path>` Artifact picks `file` and fills its path; any other is picked as written.
function artifactDraft(s: RunnerFields): Pick<RunnerDraft, "artifact" | "artifactPath" | "artifactWith"> {
  const file = /^file\s+(\S+)$/.exec(s.artifact ?? "");
  return { artifact: file ? "file" : (s.artifact ?? ""), artifactPath: file?.[1] ?? "", artifactWith: { ...s.artifactWith } };
}

/**
 * What a Runner Stage's Artifact saves as: null for none, `file <path>`, a name, `action <name>` for a check Action
 * with no params, or `{ action, with }` with them. A blank path or param is refused.
 */
function artifactValue(s: RunnerFields, d: RunnerDraft, params: Params, at: number): string | { action: string; with: Record<string, string> } | null {
  if (!d.artifact) return null;
  if (d.artifact === "file") {
    const file = d.artifactPath.trim();
    if (!file) throw new FieldError(at, "artifactPath", "a file Artifact needs a path");
    return "file " + file;
  }
  const keys = artifactKeys(s, d.artifact, params);
  if (!keys.length) return d.artifact;
  const values: Record<string, string> = {};
  for (const key of keys) {
    values[key] = (d.artifactWith[key] ?? "").trim();
    if (!values[key]) throw new FieldError(at, "artifact." + key, `${d.artifact} needs ${key}`);
  }
  return { action: checkAction(d.artifact)!, with: values };
}

/** A Runner Stage's Artifact as saved, in the shape artifactValue gives. */
function savedArtifact(s: RunnerFields): string | { action: string; with: Record<string, string> } | null {
  const action = s.artifact ? checkAction(s.artifact) : null;
  return action && s.artifactWith && Object.keys(s.artifactWith).length ? { action, with: s.artifactWith } : s.artifact;
}

let ids = 0;

/** A card for `stage`; a new one opens ready to fill in, a saved one starts closed to its one line. */
export function cardOf(stage: StageFields, fresh = false): Card {
  return { id: ++ids, stage, draft: stageDraft(stage), fresh, removed: false, open: fresh };
}

export function draftOf(pipeline: PipelineView): PipelineDraft {
  return { profile: pipeline.profile ?? "", spend: pipeline.budget.spend === undefined ? "" : String(pipeline.budget.spend), cards: pipeline.stages.map((s) => cardOf(s)) };
}

/** `cards` with a new blank Stage of `kind` after the card `after`. */
export function addStage(cards: Card[], after: number, kind: "runner" | "action"): Card[] {
  const at = cards.findIndex((c) => c.id === after) + 1;
  return [...cards.slice(0, at), cardOf(kind === "runner" ? BLANK_STAGE : BLANK_ACTION, true), ...cards.slice(at)];
}

/** `cards` with card `id` moved `by` places, removed cards counting. */
export function moveStage(cards: Card[], id: number, by: -1 | 1): Card[] {
  const from = cards.findIndex((c) => c.id === id);
  const next = cards.filter((c) => c.id !== id);
  next.splice(from + by, 0, cards[from]!);
  return next;
}

/** A new Stage goes at once; a saved one is marked removed on Save, or brought back as it was. The last kept Stage stays. */
export function removeStage(cards: Card[], id: number): Card[] {
  const card = cards.find((c) => c.id === id)!;
  if (card.fresh) return cards.filter((c) => c.id !== id);
  if (!card.removed && cards.filter((c) => !c.removed).length === 1) return cards;
  return cards.map((c) => (c.id === id ? { ...c, removed: !c.removed } : c));
}

/** The name a closed card shows. */
export function stageTitle(card: Card): string {
  if (card.draft.kind === "action") return card.fresh ? "New Stage" : card.stage.name;
  return card.draft.name.trim() || "New Stage";
}

// A blank clears the key; a number field must hold a number.
function numberOrNull(raw: string, stage: number | null, field: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new FieldError(stage, field, field + " must be a number");
  return Number(value);
}

// Empty mappings inside the patch go, so an untouched budget sends nothing.
function prune<T extends Record<string, unknown>>(patch: T): T {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      prune(v as Record<string, unknown>);
      if (!Object.keys(v).length) delete patch[k];
    }
  }
  return patch;
}

/**
 * What one card sends: for a saved Stage only the fields that changed, a blank clearing its key; for a new one,
 * what it sets against a blank Stage, which goes in `order`. `at` is the card's place, for a FieldError.
 */
export function stagePatch(card: Card, params: Params, at: number): Record<string, unknown> {
  const { stage: s, draft: d } = card;
  if (s.kind === "action" && d.kind === "action") {
    const next = Object.fromEntries(actionKeys(s, d.action, params).map((key) => [key, (d.with[key] ?? "").trim()]));
    // A param left blank is left out, so the save names it as missing.
    if (card.fresh) return { action: d.action, with: Object.fromEntries(Object.entries(next).filter(([, value]) => value)) };
    const patch: Record<string, unknown> = {};
    if (d.action !== s.action) patch.action = d.action;
    const w: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(next)) if (value !== s.with[key]) w[key] = value || null;
    for (const key of Object.keys(s.with)) if (!(key in next)) w[key] = null;
    if (Object.keys(w).length) patch.with = w;
    return patch;
  }
  if (s.kind !== "runner" || d.kind !== "runner") throw new Error("a Stage cannot change kind");
  // Budget goes first, as the old editor built it, so a new Stage's keys land in the file in the same order.
  const budget: Record<string, unknown> = {};
  const patch: Record<string, unknown> = { budget };
  const changed = (into: Record<string, unknown>, key: string, before: unknown, after: unknown) => {
    if (before !== after) into[key] = after;
  };
  changed(patch, "name", s.name, d.name.trim());
  changed(patch, "prompt", s.prompt, d.prompt === "" ? null : d.prompt);
  const skills = d.skills.split(",").map((x) => x.trim()).filter(Boolean);
  if (skills.join(",") !== s.skills.join(",")) patch.skills = skills.length ? skills : null;
  if (d.profile !== s.profile) patch.profile = d.profile;
  const artifact = artifactValue(s, d, params, at);
  if (JSON.stringify(artifact) !== JSON.stringify(savedArtifact(s))) patch.artifact = artifact;
  if (d.human !== s.human) patch.human = d.human ? true : null;
  if (d.advance !== s.advance) patch.advance = d.advance ? null : false;
  if (d.repeat !== (s.repeat === "feedback")) patch.repeat = d.repeat ? "feedback" : null;
  changed(budget, "rounds", s.budget.rounds ?? null, numberOrNull(d.rounds, at, "rounds"));
  changed(budget, "attempts", s.budget.attempts ?? null, numberOrNull(d.attempts, at, "attempts"));
  changed(budget, "wallTime", s.budget.wallTime ?? null, d.wallTime.trim() || null);
  return prune(patch);
}

/**
 * The PATCH that saves `draft` over `pipeline`: only changed fields, keyed by each Stage's saved name, a blank
 * clearing its key; and the new order, with each new Stage's fields in its place, when Stages were added, moved or
 * removed. Empty when nothing changed. Throws FieldError for a number field that holds something else.
 */
export function pipelinePatch(pipeline: PipelineView, draft: PipelineDraft, params: Params): PipelinePatch {
  const stages: Record<string, Record<string, unknown>> = {};
  const patch: PipelinePatch = { budget: {}, stages };
  if (draft.profile !== (pipeline.profile ?? "")) patch.profile = draft.profile || null;
  const spend = numberOrNull(draft.spend, null, "spend");
  if ((pipeline.budget.spend ?? null) !== spend) patch.budget!.spend = spend;
  const kept = draft.cards.filter((c) => !c.removed);
  for (const card of kept) {
    if (card.fresh) continue;
    const sp = stagePatch(card, params, draft.cards.indexOf(card));
    if (Object.keys(sp).length) stages[card.stage.name] = sp;
  }
  prune(patch as Record<string, unknown>);
  const order = kept.map((c) => (c.fresh ? stagePatch(c, params, draft.cards.indexOf(c)) : c.stage.name));
  if (kept.some((c) => c.fresh) || order.join("\n") !== pipeline.stages.map((s) => s.name).join("\n")) patch.order = order;
  return patch;
}
