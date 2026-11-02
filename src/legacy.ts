import { existsSync } from "node:fs";
import path from "node:path";

// Laisso was named Lasso. What a Lasso install left behind keeps working: a home under ~/.lasso (by
// LAISSO_DIRECTORY_NAME=.lasso), its lasso.db, LASSO_HOME and LASSO_PORT, and Action scripts and prompts that read
// LASSO_* variables. Everything for that lives here, so it can go in one change.

/** The home directory's name under the user's home: LAISSO_DIRECTORY_NAME when set, so ~/.lasso can stay in use. */
export function homeDirName(env: NodeJS.ProcessEnv): string {
  return env.LAISSO_DIRECTORY_NAME || ".laisso";
}

/** LAISSO_<name> from `env`, or Lasso's LASSO_<name> where only that is set. */
export function laissoEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`LAISSO_${name}`] || env[`LASSO_${name}`] || undefined;
}

/** The name the home's own files start with: lasso for a home Lasso made (it has lasso.db and no laisso.db), else laisso. */
export function homeFileStem(root: string): "laisso" | "lasso" {
  return !existsSync(path.join(root, "laisso.db")) && existsSync(path.join(root, "lasso.db")) ? "lasso" : "laisso";
}

/** `vars` with each LAISSO_* also under its Lasso name, for scripts and prompts written against LASSO_*. */
export function withLegacyNames(vars: Record<string, string>): Record<string, string> {
  const legacy = Object.entries(vars)
    .filter(([key]) => key.startsWith("LAISSO_"))
    .map(([key, value]) => [`LASSO_${key.slice("LAISSO_".length)}`, value]);
  return { ...vars, ...Object.fromEntries(legacy) };
}

/** Where Lasso installed its skill beside `dir`, and the stamp that marks a copy as Lasso's own. */
export function legacySkillDir(dir: string): { dir: string; stamp: string } {
  return { dir: path.join(path.dirname(dir), "lasso"), stamp: ".lasso-version" };
}
