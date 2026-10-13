import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The Lasso skill: docs for coding agents that ship in the package, so the
 * copy an agent reads always matches the Lasso that installed it.
 */

/** The file in an installed copy naming the Lasso version that wrote it; SKILL.md's frontmatter stays as shipped. */
export const VERSION_FILE = ".lasso-version";

/** Where one agent looks for the skill. */
export interface SkillTarget {
  agent: "claude" | "codex";
  dir: string;
}

/**
 * Where the skill goes under a user's home: Claude Code's skills always, and
 * Codex's only on a machine that has Codex (a ~/.codex directory).
 */
export function skillTargets(userHome: string): SkillTarget[] {
  const targets: SkillTarget[] = [{ agent: "claude", dir: path.join(userHome, ".claude", "skills", "lasso") }];
  if (existsSync(path.join(userHome, ".codex"))) targets.push({ agent: "codex", dir: path.join(userHome, ".codex", "skills", "lasso") });
  return targets;
}

/** One target's install: the copy it replaces, if any, and the files it ends up with, relative to its directory. */
export interface SkillInstall extends SkillTarget {
  replaces: boolean;
  files: string[];
}

export class SkillMissing extends Error {
  constructor(source: string) {
    super(`the Lasso skill is missing from this install (${source})`);
  }
}

/**
 * Copy the skill from `source` into each target, replacing any copy already
 * there whole so a file the new version dropped does not linger, and stamp
 * it with `version`. With `dryRun` nothing is written; the plan is the same.
 */
export function installSkill(source: string, targets: SkillTarget[], version: string, opts: { dryRun?: boolean } = {}): SkillInstall[] {
  if (!existsSync(path.join(source, "SKILL.md"))) throw new SkillMissing(source);
  const files = [...listFiles(source), VERSION_FILE].sort();
  return targets.map((target) => {
    const replaces = existsSync(target.dir);
    if (!opts.dryRun) {
      rmSync(target.dir, { recursive: true, force: true });
      cpSync(source, target.dir, { recursive: true });
      writeFileSync(path.join(target.dir, VERSION_FILE), version + "\n");
    }
    return { ...target, replaces, files };
  });
}

/** Every file under `dir`, relative to it, with / separators. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** One agent's copy of the skill as doctor reports it: absent, written by this Lasso, or by another (null when unstamped). */
export interface SkillStatus extends SkillTarget {
  state: "missing" | "current" | "other";
  installed: string | null;
}

export function skillStatus(userHome: string, version: string): SkillStatus[] {
  return skillTargets(userHome).map((target) => {
    if (!existsSync(path.join(target.dir, "SKILL.md"))) return { ...target, state: "missing", installed: null };
    const installed = stampOf(target.dir);
    return { ...target, state: installed === version ? "current" : "other", installed };
  });
}

function stampOf(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, VERSION_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}
