import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultConfigYaml } from "./config.ts";
import { DEFAULT_PIPELINE_YAML } from "../pipeline/default.ts";
import { PR_REVIEW_PIPELINE_YAML } from "../pipeline/pr-review.ts";

/** The Lasso home: everything Lasso owns lives under it (ADR 0006). */
export interface LassoHome {
  root: string;
  configFile: string;
  pipelinesDir: string;
  ticketsDir: string;
  dbFile: string;
  backupsDir: string;
  pidFile: string;
  logFile: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): LassoHome {
  const root = env.LASSO_HOME ? path.resolve(env.LASSO_HOME) : path.join(homedir(), ".lasso");
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    pipelinesDir: path.join(root, "pipelines"),
    ticketsDir: path.join(root, "tickets"),
    dbFile: path.join(root, "lasso.db"),
    backupsDir: path.join(root, "backups"),
    pidFile: path.join(root, "lasso.pid"),
    logFile: path.join(root, "lasso.log"),
  };
}

/**
 * Create the home's directories and write defaults that are absent. Never overwrites, so LASSO_PORT, which sets a
 * new config's port, has no effect on a home that already has one.
 */
export function ensureHome(home: LassoHome, env: NodeJS.ProcessEnv = process.env): { wroteConfig: boolean; wrotePipelines: string[] } {
  mkdirSync(home.pipelinesDir, { recursive: true });
  mkdirSync(home.ticketsDir, { recursive: true });
  const wroteConfig = writeIfAbsent(home.configFile, () => defaultConfigYaml(env));
  const wrotePipelines = Object.entries(SHIPPED_PIPELINES)
    .filter(([name, yaml]) => writeIfAbsent(path.join(home.pipelinesDir, `${name}.yaml`), () => yaml))
    .map(([name]) => name);
  return { wroteConfig, wrotePipelines };
}

/** The Pipelines Lasso ships, by name: each is written when its file is absent and never overwritten. */
export const SHIPPED_PIPELINES: Record<string, string> = { default: DEFAULT_PIPELINE_YAML, "pr-review": PR_REVIEW_PIPELINE_YAML };

function writeIfAbsent(file: string, content: () => string): boolean {
  if (existsSync(file)) return false;
  writeFileSync(file, content(), { flag: "wx" });
  return true;
}
