import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultConfigYaml } from "./config.ts";
import { DEFAULT_PIPELINE_YAML } from "../pipeline/default.ts";
import { PR_REVIEW_PIPELINE_YAML } from "../pipeline/pr-review.ts";
import { homeDirName, homeFileStem, laissoEnv } from "../legacy.ts";

/** The Laisso home: everything Laisso owns lives under it (ADR 0006), ~/.laisso unless LAISSO_HOME or LAISSO_DIRECTORY_NAME says otherwise. */
export interface LaissoHome {
  root: string;
  configFile: string;
  pipelinesDir: string;
  ticketsDir: string;
  dbFile: string;
  backupsDir: string;
  pidFile: string;
  logFile: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): LaissoHome {
  const home = laissoEnv(env, "HOME");
  const root = home ? path.resolve(home) : path.join(homedir(), homeDirName(env));
  const stem = homeFileStem(root);
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    pipelinesDir: path.join(root, "pipelines"),
    ticketsDir: path.join(root, "tickets"),
    dbFile: path.join(root, `${stem}.db`),
    backupsDir: path.join(root, "backups"),
    pidFile: path.join(root, `${stem}.pid`),
    logFile: path.join(root, `${stem}.log`),
  };
}

/**
 * Create the home's directories and write defaults that are absent. Never overwrites, so LAISSO_PORT, which sets a
 * new config's port, has no effect on a home that already has one.
 */
export function ensureHome(home: LaissoHome, env: NodeJS.ProcessEnv = process.env): { wroteConfig: boolean; wrotePipelines: string[] } {
  mkdirSync(home.pipelinesDir, { recursive: true });
  mkdirSync(home.ticketsDir, { recursive: true });
  const wroteConfig = writeIfAbsent(home.configFile, () => defaultConfigYaml(env));
  const wrotePipelines = Object.entries(SHIPPED_PIPELINES)
    .filter(([name, yaml]) => writeIfAbsent(path.join(home.pipelinesDir, `${name}.yaml`), () => yaml))
    .map(([name]) => name);
  return { wroteConfig, wrotePipelines };
}

/** The Pipelines Laisso ships, by name: each is written when its file is absent and never overwritten. */
export const SHIPPED_PIPELINES: Record<string, string> = { default: DEFAULT_PIPELINE_YAML, "pr-review": PR_REVIEW_PIPELINE_YAML };

function writeIfAbsent(file: string, content: () => string): boolean {
  if (existsSync(file)) return false;
  writeFileSync(file, content(), { flag: "wx" });
  return true;
}
