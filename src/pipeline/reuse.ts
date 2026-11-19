import { isPlainObject } from "../fields.ts";
import type { Stage } from "./load.ts";

/**
 * Where a copied Stage came from (CONTEXT.md: Reused Stage): the Pipeline and
 * the Stage's name there, and whether a `use` or an `include` entry took it.
 * Own Stages carry none, so their Versions are unchanged.
 */
export interface Origin {
  pipeline: string;
  stage: string;
  how: "use" | "include";
}

/** The fields a Stage's kind is decided by; an override may not bring in another kind's. */
const KIND_FIELDS: Record<Stage["kind"], string[]> = {
  runner: ["action", "wait"],
  action: ["prompt", "skills", "append", "wait"],
  wait: ["prompt", "skills", "append", "action"],
};

/** Fields whose value is a mapping an override merges into key by key, a null value removing that key. */
const MAP_FIELDS = new Set(["budget", "routes", "with"]);

/** `use:`'s value, `<pipeline>.<stage>`; Pipeline names have no dots, so the first dot splits them. */
export function useRef(value: unknown): { pipeline: string; stage: string } | null {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  return { pipeline: value.slice(0, dot), stage: value.slice(dot + 1) };
}

/**
 * A Stage as the fields a Pipeline file would write for it, so overrides can
 * be laid on it and the result parsed and checked like any Stage. An action
 * Stage's name is written only when it is not the one its Action and params
 * give, so changing `with` on an unnamed one names it afresh.
 */
export function rawStage(stage: Stage, derivedName: (action: string, params: Record<string, string>) => string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) raw[key] = value;
  };
  const checkAction = (artifact: string, params: Record<string, string>) => ({ action: artifact.replace(/^action\s+/, ""), with: { ...params } });
  if (stage.kind === "action") {
    set("action", stage.action);
    if (stage.name !== derivedName(stage.action, stage.with)) set("name", stage.name);
    set("with", { ...stage.with });
  } else if (stage.kind === "wait") {
    set("name", stage.name);
    set("wait", checkAction(stage.wait, stage.waitWith));
    if (!stage.advance) set("advance", false);
    if (stage.budget.wallTime !== undefined) set("budget", { wallTime: stage.budget.wallTime });
  } else {
    set("name", stage.name);
    if (stage.prompt !== null) set("prompt", stage.prompt);
    if (stage.skills.length) set("skills", [...stage.skills]);
    if (stage.profile !== null) set("profile", stage.profile);
    if (stage.human) set("human", true);
    if (!stage.advance) set("advance", false);
    if (stage.artifact !== null) set("artifact", stage.artifactWith && Object.keys(stage.artifactWith).length ? checkAction(stage.artifact, stage.artifactWith) : stage.artifact);
    if (stage.repeat) set("repeat", stage.repeat);
    const budget = Object.fromEntries(Object.entries(stage.budget).filter(([, v]) => v !== undefined));
    if (Object.keys(budget).length) set("budget", budget);
    if (stage.agentRoutes) set("agentRoutes", true);
  }
  if (stage.routes) set("routes", Object.fromEntries(Object.entries(stage.routes).map(([name, route]) => [name, { ...route }])));
  return raw;
}

/**
 * Lay a `use` entry's (or an include's `change`) fields over a source Stage's:
 * any field but its kind. `prompt` replaces and `append` adds after the
 * source's prompt; `budget`, `routes` and `with` merge key by key, a null
 * removing that key; anything else, lists included, replaces, and null clears.
 */
export function applyOverrides(source: Record<string, unknown>, kind: Stage["kind"], overrides: Record<string, unknown>, fail: (message: string) => Error): Record<string, unknown> {
  if (overrides.prompt !== undefined && overrides.append !== undefined) throw fail("set prompt or append, not both");
  const result: Record<string, unknown> = { ...source };
  for (const [key, value] of Object.entries(overrides)) {
    if (KIND_FIELDS[kind].includes(key)) throw fail(`${key} does not fit a reused ${kind} Stage; a reused Stage keeps its kind`);
    if (key === "append") {
      if (typeof value !== "string") throw fail(`append must be text, not ${String(value)}`);
      const prompt = typeof source.prompt === "string" ? source.prompt : null;
      result.prompt = prompt ? `${prompt.replace(/\s+$/, "")}\n\n${value}` : value;
    } else if (MAP_FIELDS.has(key) && value !== null) {
      if (!isPlainObject(value)) throw fail(`${key} must be a mapping`);
      const merged: Record<string, unknown> = isPlainObject(source[key]) ? { ...(source[key] as Record<string, unknown>) } : {};
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      if (Object.keys(merged).length) result[key] = merged;
      else delete result[key];
    } else if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}
