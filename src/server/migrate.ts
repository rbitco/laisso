import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isMap, isSeq, parseDocument, Scalar, type Document, type ToStringOptions, type YAMLMap } from "yaml";
import { listPipelines, pipelineFile } from "../pipeline/load.ts";
import { replaceFile } from "../atomic-write.ts";
import type { LassoHome } from "./home.ts";

/**
 * The move of tracker.transition from Lasso's code into config (ADR 0010),
 * run at every start before config or any Pipeline is read. Each step finds
 * its own work, so a second run changes nothing.
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

/** Keep what the migration does not touch as it was: no line folding, no padding added inside [flow] collections. */
const WRITE: ToStringOptions = { lineWidth: 0, flowCollectionPadding: false };

export interface Migrated {
  config: boolean;
  pipelines: string[];
  versions: number;
}

/** Migrate config.yaml and the Pipeline files in the home; the pinned Versions are migrateVersions', once the store is open. */
export function migrateHome(home: LassoHome): Omit<Migrated, "versions"> {
  const config = migrateFile(home.configFile, migrateConfigText);
  const pipelines = listPipelines(home.pipelinesDir).filter((name) => {
    const file = pipelineFile(home.pipelinesDir, name);
    return file ? migrateFile(file, migratePipelineText) : false;
  });
  return { config, pipelines };
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
  return doc.toString(WRITE);
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
  return changed ? doc.toString(WRITE) : null;
}

/** An action Stage in a Version's definition, as the parser wrote it before ADR 0010 and after. */
type StoredStage = Record<string, unknown> & { kind?: unknown; status?: unknown };

/**
 * Rewrite each pinned Version's old tracker.transition Stages into the shape
 * the parser now gives the migrated file, key order included, so drift still
 * reads same for a Ticket whose Pipeline only went through the migration.
 * Returns how many Versions changed.
 */
export function migrateVersions(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT pipeline, version, definition FROM pipeline_versions`).all() as Array<{ pipeline: string; version: number; definition: string }>;
  const update = db.prepare(`UPDATE pipeline_versions SET definition = ? WHERE pipeline = ? AND version = ?`);
  let count = 0;
  for (const row of rows) {
    const definition = JSON.parse(row.definition) as { stages?: StoredStage[] };
    let changed = false;
    definition.stages = (definition.stages ?? []).map((stage) => {
      if (stage.kind !== "action" || stage.status === undefined) return stage;
      changed = true;
      return { kind: "action", name: stage.name, action: stage.action, with: { status: String(stage.status) } };
    });
    if (!changed) continue;
    update.run(JSON.stringify(definition), row.pipeline, row.version);
    count++;
  }
  return count;
}
