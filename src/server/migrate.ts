import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isMap, isScalar, isSeq, parseDocument, Scalar, type Document, type Pair, type YAMLMap } from "yaml";
import { writeLike } from "../yaml-edit.ts";
import { listPipelines, parsePipeline, pipelineFile, RUNNERS } from "../pipeline/load.ts";
import { replaceFile } from "../atomic-write.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { LassoHome } from "./home.ts";

/**
 * Moves of Lasso's own model into config, run at every start before config
 * or any Pipeline is read: tracker.transition into a config Action (ADR
 * 0010), and runner: and runnerOptions into Agent Profiles (ADR 0011).
 * Each step finds its own work, so a second run changes nothing.
 */

/** tracker.transition as a config Action: acli for JIRA, the global default. */
export const JIRA_TRANSITION = {
  params: ["status"],
  run: [
    `[ -n "$LASSO_REFERENCE" ] || { echo "$LASSO_STAGE: the Ticket has no tracker issue yet" >&2; exit 1; }`,
    `acli jira workitem transition --key "$LASSO_REFERENCE" --status "$LASSO_STATUS" --yes >&2 || exit $?`,
    `echo "moved $LASSO_REFERENCE to $LASSO_STATUS"`,
  ].join("\n"),
};

/** The override a GitHub repo gets: an issue is only open or closed, so the status picks gh issue reopen or close. */
export const GITHUB_TRANSITION = {
  params: ["status"],
  run: [
    `[ -n "$LASSO_REFERENCE" ] || { echo "$LASSO_STAGE: the Ticket has no tracker issue yet" >&2; exit 1; }`,
    `case "$(printf %s "$LASSO_STATUS" | tr '[:upper:]' '[:lower:]')" in`,
    `  closed) verb=close ;;`,
    `  open) verb=reopen ;;`,
    `  *) echo "GitHub accepts only open and closed, not $LASSO_STATUS" >&2; exit 1 ;;`,
    `esac`,
    `gh issue "$verb" "\${LASSO_REFERENCE##*#}" --repo "\${LASSO_REFERENCE%#*}" >&2 || exit $?`,
    `echo "moved $LASSO_REFERENCE to $LASSO_STATUS"`,
  ].join("\n"),
};

export interface Migrated {
  config: boolean;
  pipelines: string[];
  versions: number;
}

/** A profile the migration writes into config.yaml: a Runner a Pipeline named, a Stage's runnerOptions with its Runner, or a built-in one. */
export interface MigratedProfile {
  runner: string;
  model?: string;
  permission?: string;
  args?: string[];
  skills_dir?: string;
}

/**
 * Migrate the Pipeline files in the home, then config.yaml with the
 * profiles they now name; the pinned Versions are migrateVersions', once
 * the store is open.
 */
export function migrateHome(home: LassoHome): Omit<Migrated, "versions"> {
  const profiles: Record<string, MigratedProfile> = {};
  const pipelines = listPipelines(home.pipelinesDir).filter((name) => {
    const file = pipelineFile(home.pipelinesDir, name);
    return file
      ? migrateFile(file, (text) => {
          const statuses = migratePipelineText(text);
          const moved = migratePipelineProfilesText(name, statuses ?? text);
          if (moved) Object.assign(profiles, { ...moved.profiles, ...profiles });
          return moved?.text ?? statuses;
        })
      : false;
  });
  const config = migrateFile(home.configFile, (text) => {
    const actions = migrateConfigText(text);
    return migrateConfigProfilesText(actions ?? text, profiles) ?? actions;
  });
  return { config, pipelines };
}

/** Write the profiles pinned Versions name that config.yaml lacks; true when config.yaml changed. */
export function migrateConfigProfiles(home: LassoHome, profiles: Record<string, MigratedProfile>): boolean {
  return migrateFile(home.configFile, (text) => migrateConfigProfilesText(text, profiles));
}

function migrateFile(file: string, migrate: (text: string) => string | null): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let next: string | null;
  try {
    next = migrate(text);
  } catch {
    // A file that does not parse is left for its own error to report.
    return false;
  }
  if (next === null) return false;
  replaceFile(file, next);
  return true;
}

/**
 * config.yaml without a global tracker.transition gets one, and each GitHub
 * repo without its own gets the gh override. Comments are kept. Null when
 * there is nothing to do, including when the global one is already there:
 * that is a migrated file, whose repos are the human's to keep.
 */
export function migrateConfigText(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length) throw doc.errors[0];
  const raw = (doc.toJS() ?? {}) as { actions?: Record<string, unknown>; repos?: Record<string, { tracker?: unknown; actions?: Record<string, unknown> } | null> };
  if (raw.actions?.["tracker.transition"] !== undefined) return null;
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  setBlock(doc, ["actions", "tracker.transition"], actionNode(doc, JIRA_TRANSITION));
  for (const [name, repo] of Object.entries(raw.repos ?? {})) {
    if (repo?.tracker !== "github" || repo.actions?.["tracker.transition"] !== undefined) continue;
    setBlock(doc, ["repos", name, "actions", "tracker.transition"], actionNode(doc, GITHUB_TRANSITION));
  }
  return doc.toString(writeLike(text));
}

/** An Action as a human would write it: params inline, the command as a literal block. */
function actionNode(doc: Document, action: { params: string[]; run: string }) {
  const params = doc.createNode(action.params);
  params.flow = true;
  const run = new Scalar(action.run);
  run.type = Scalar.BLOCK_LITERAL;
  return doc.createNode({ params, run });
}

/** Set a value, turning each mapping on the way into block style so the Action reads as config.yaml's other entries do. */
function setBlock(doc: Document, at: string[], node: unknown): void {
  doc.setIn(at, node);
  for (let i = 1; i < at.length; i++) {
    const node = doc.getIn(at.slice(0, i), true);
    if (isMap(node)) node.flow = false;
  }
}

/** A Pipeline's `status: X` on an action Stage becomes `with: { status: X }`; null when no Stage has one. */
export function migratePipelineText(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length) throw doc.errors[0];
  const stages = doc.get("stages", true);
  if (!isSeq(stages)) return null;
  let changed = false;
  for (const item of stages.items) {
    if (!isMap(item) || !item.has("action") || !item.has("status")) continue;
    const stage = item as YAMLMap;
    const status = stage.get("status");
    stage.delete("status");
    const params = doc.createNode({ status: String(status) });
    params.flow = true;
    stage.set("with", params);
    changed = true;
  }
  return changed ? doc.toString(writeLike(text)) : null;
}

/**
 * config.yaml gets each profile the migrated Pipelines name that it does not
 * define already, and `default_profile: claude` when it has none, with a
 * runner-only claude profile for it: a Pipeline without runner: ran on
 * Claude. A fresh install's config.yaml has its default_profile, so it is
 * left alone. Comments are kept; null when there is nothing to do.
 */
export function migrateConfigProfilesText(text: string, profiles: Record<string, MigratedProfile>): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length) throw doc.errors[0];
  const raw = (doc.toJS() ?? {}) as { profiles?: Record<string, unknown> | null; default_profile?: unknown };
  const needed: Record<string, MigratedProfile> = { ...profiles };
  const setDefault = raw.default_profile === undefined;
  if (setDefault) needed.claude ??= { runner: "claude" };
  // Without a profiles: key, a config that has its default_profile reads as the built-in profiles; writing any other would lose them.
  else if (raw.profiles === undefined && Object.keys(needed).length) for (const [name, profile] of Object.entries(DEFAULT_CONFIG.profiles)) needed[name] ??= profile;
  const missing = Object.entries(needed).filter(([name]) => raw.profiles?.[name] === undefined);
  if (!missing.length && !setDefault) return null;
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  for (const [name, profile] of missing.sort(([a], [b]) => a.localeCompare(b))) setBlock(doc, ["profiles", name], profileNode(doc, profile));
  if (setDefault) doc.set("default_profile", "claude");
  return doc.toString(writeLike(text));
}

/** A profile as a human would write it: args inline. */
function profileNode(doc: Document, profile: MigratedProfile) {
  const fields: Record<string, unknown> = { runner: profile.runner };
  if (profile.model) fields.model = profile.model;
  if (profile.permission) fields.permission = profile.permission;
  if (profile.args) {
    const args = doc.createNode(profile.args);
    args.flow = true;
    fields.args = args;
  }
  if (profile.skills_dir) fields.skills_dir = profile.skills_dir;
  return doc.createNode(fields);
}

/**
 * A Pipeline's `runner: X`, on the Pipeline or a Stage, becomes `profile: X`.
 * A Stage with runnerOptions gets a profile of its own, `<pipeline>-<stage>`,
 * holding its Runner and args (skillsDir as skills_dir). Returns the text
 * and the profiles it now names, or null when there is no runner: to move.
 */
export function migratePipelineProfilesText(name: string, text: string): { text: string; profiles: Record<string, MigratedProfile> } | null {
  const doc = parseDocument(text);
  if (doc.errors.length) throw doc.errors[0];
  if (!isMap(doc.contents)) return null;
  const profiles: Record<string, MigratedProfile> = {};
  let changed = false;
  const top = pairOf(doc.contents, "runner");
  const pipelineRunner = top ? runnerName(top.value, `Pipeline ${name}`) : "claude";
  if (top) {
    rename(top, "profile");
    profiles[pipelineRunner] = { runner: pipelineRunner };
    changed = true;
  }
  const stages = doc.get("stages", true);
  for (const item of isSeq(stages) ? stages.items : []) {
    if (!isMap(item) || item.has("action")) continue;
    const runner = pairOf(item, "runner");
    const options = pairOf(item, "runnerOptions");
    if (!runner && !options) continue;
    changed = true;
    const stageName = String(item.get("name"));
    const stageRunner = runner ? runnerName(runner.value, `Pipeline ${name} Stage ${stageName}`) : pipelineRunner;
    const own = options ? optionsProfile(stageRunner, isMap(options.value) ? options.value.toJSON() : null) : null;
    if (own) {
      // The Stage's own profile takes the place of its runner:, else of its runnerOptions.
      const profile = `${name}-${stageName}`;
      profiles[profile] = own;
      const at = runner ?? options!;
      rename(at, "profile");
      at.value = doc.createNode(profile);
      if (runner) item.items.splice(item.items.indexOf(options!), 1);
      continue;
    }
    if (options) item.items.splice(item.items.indexOf(options), 1);
    if (runner) {
      rename(runner, "profile");
      profiles[stageRunner] = { runner: stageRunner };
    }
  }
  return changed ? { text: doc.toString(writeLike(text)), profiles } : null;
}

/** A Stage's own profile from its runnerOptions; null when they carried nothing a Runner read (args and skillsDir were all). */
function optionsProfile(runner: string, options: unknown): MigratedProfile | null {
  const o = (options && typeof options === "object" ? options : {}) as { args?: unknown; skillsDir?: unknown };
  const args = Array.isArray(o.args) ? o.args.map(String) : null;
  const skillsDir = typeof o.skillsDir === "string" ? o.skillsDir : null;
  if (!args && !skillsDir) return null;
  return { runner, ...(args ? { args } : {}), ...(skillsDir ? { skills_dir: skillsDir } : {}) };
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
}

/** Rename a key where it stands, so its comments and place stay. */
function rename(pair: Pair, key: string): void {
  if (isScalar(pair.key)) pair.key.value = key;
  else pair.key = new Scalar(key);
}

/** A runner the old loader accepted; anything else left the file broken, so it is left for its own error to report. */
function runnerName(value: unknown, where: string): string {
  const runner = String(isScalar(value) ? value.value : value);
  if (!(RUNNERS as readonly string[]).includes(runner)) throw new Error(`${where}: unknown runner ${runner}`);
  return runner;
}

/** A Stage in a Version's definition: an action Stage as the parser wrote it before ADR 0010 and after, a Runner Stage before ADR 0011 and after. */
type StoredStage = Record<string, unknown> & { kind?: unknown; status?: unknown; name?: unknown; runner?: unknown; inheritsRunner?: unknown; runnerOptions?: unknown };
type StoredPipeline = Record<string, unknown> & { name?: unknown; runner?: unknown; stages?: StoredStage[] };

/**
 * Rewrite each pinned Version into the shape the parser now gives the
 * migrated file, key order included, so drift still reads same for a Ticket
 * whose Pipeline only went through the migration: old tracker.transition
 * Stages, and runner and runnerOptions as profiles. Returns how many
 * Versions changed, and the profiles they now name for config.yaml.
 */
export function migrateVersions(db: DatabaseSync, pipelinesDir: string): { versions: number; profiles: Record<string, MigratedProfile> } {
  const rows = db.prepare(`SELECT pipeline, version, definition FROM pipeline_versions`).all() as Array<{ pipeline: string; version: number; definition: string }>;
  const update = db.prepare(`UPDATE pipeline_versions SET definition = ? WHERE pipeline = ? AND version = ?`);
  const profiles: Record<string, MigratedProfile> = {};
  let count = 0;
  for (const row of rows) {
    let definition = JSON.parse(row.definition) as StoredPipeline;
    let changed = false;
    definition.stages = (definition.stages ?? []).map((stage) => {
      if (stage.kind !== "action" || stage.status === undefined) return stage;
      changed = true;
      return { kind: "action", name: stage.name, action: stage.action, with: { status: String(stage.status) } };
    });
    if (typeof definition.runner === "string") {
      definition = versionWithProfiles(row.pipeline, definition, profiles, pipelinesDir);
      changed = true;
    }
    if (!changed) continue;
    update.run(JSON.stringify(definition), row.pipeline, row.version);
    count++;
  }
  return { versions: count, profiles };
}

/**
 * A Version from before ADR 0011 with profiles in place of runners, as
 * migratePipelineProfilesText leaves its file. The parser wrote claude for a
 * Pipeline that named no runner too, so a claude Pipeline names the claude
 * profile unless inheriting the default is what the migrated file says.
 */
function versionWithProfiles(name: string, definition: StoredPipeline, profiles: Record<string, MigratedProfile>, pipelinesDir: string): StoredPipeline {
  const runner = String(definition.runner);
  const stages = (definition.stages ?? []).map((stage) => {
    if (stage.kind !== "runner" || stage.runner === undefined) return stage;
    const stageRunner = String(stage.runner);
    const own = optionsProfile(stageRunner, stage.runnerOptions);
    const profile = own ? `${name}-${String(stage.name)}` : stage.inheritsRunner === true ? null : stageRunner;
    if (profile) profiles[profile] ??= own ?? { runner: stageRunner };
    return replaceKey(stage, "runner", "profile", profile, ["inheritsRunner", "runnerOptions"]);
  });
  const as = (profile: string | null) => replaceKey({ ...definition, stages }, "runner", "profile", profile, []);
  if (runner === "claude") {
    const inheriting = as(null);
    const file = pipelineFile(pipelinesDir, name);
    try {
      if (file && JSON.stringify(parsePipeline(name, readFileSync(file, "utf8"))) === JSON.stringify(inheriting)) return inheriting;
    } catch {
      // A file that does not load is the drift's to report.
    }
  }
  profiles[runner] ??= { runner };
  return as(runner);
}

/** The object with `from` renamed `to` where it stood, holding `value`, and the `drop` keys gone. */
function replaceKey<T extends Record<string, unknown>>(object: T, from: string, to: string, value: unknown, drop: string[]): T {
  return Object.fromEntries(Object.entries(object).flatMap(([k, v]) => (k === from ? [[to, value]] : drop.includes(k) ? [] : [[k, v]]))) as T;
}
