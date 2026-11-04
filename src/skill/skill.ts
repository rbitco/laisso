import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { legacySkillDir } from "../legacy.ts";

/**
 * The Laisso skill: docs for coding agents that ship in the package, so the
 * copy an agent reads always matches the Laisso that installed it.
 */

/** The file in an installed copy naming the Laisso version that wrote it; SKILL.md's frontmatter stays as shipped. */
export const VERSION_FILE = ".laisso-version";

/**
 * The skills the package ships, each a directory of the same name under its skills/: `laisso`, the reference docs,
 * and `laisso-setup`, the walkthrough `laisso setup` runs.
 */
export const SHIPPED_SKILLS = ["laisso", "laisso-setup"] as const;
export type SkillName = (typeof SHIPPED_SKILLS)[number];

/** Where one agent looks for one skill. */
export interface SkillTarget {
  skill: SkillName;
  agent: "claude" | "codex";
  dir: string;
}

/**
 * Where a skill goes under a user's home: Claude Code's skills always, and
 * Codex's only on a machine that has Codex (a ~/.codex directory).
 */
export function skillTargets(userHome: string, skill: SkillName = "laisso"): SkillTarget[] {
  const targets: SkillTarget[] = [{ skill, agent: "claude", dir: path.join(userHome, ".claude", "skills", skill) }];
  if (existsSync(path.join(userHome, ".codex"))) targets.push({ skill, agent: "codex", dir: path.join(userHome, ".codex", "skills", skill) });
  return targets;
}

/** One target's install: the copy it replaces, if any, and the files it ends up with, relative to its directory. */
export interface SkillInstall extends SkillTarget {
  replaces: boolean;
  files: string[];
}

export class SkillMissing extends Error {
  constructor(source: string) {
    super(`the Laisso skill is missing from this install (${source})`);
  }
}

/**
 * Copy the skill from `source` into each target, replacing any copy already
 * there whole so a file the new version dropped does not linger, and stamp
 * it with `version`; a copy Lasso installed beside it goes. With `dryRun` nothing is written; the plan is the same.
 */
export function installSkill(source: string, targets: SkillTarget[], version: string, opts: { dryRun?: boolean } = {}): SkillInstall[] {
  if (!existsSync(path.join(source, "SKILL.md"))) throw new SkillMissing(source);
  const files = [...listFiles(source), VERSION_FILE].sort();
  return targets.map((target) => {
    const replaces = existsSync(target.dir);
    if (!opts.dryRun) {
      rmSync(target.dir, { recursive: true, force: true });
      const legacy = legacySkillDir(target.dir);
      if (existsSync(path.join(legacy.dir, legacy.stamp))) rmSync(legacy.dir, { recursive: true, force: true });
      cpSync(source, target.dir, { recursive: true });
      writeFileSync(path.join(target.dir, VERSION_FILE), version + "\n");
    }
    return { ...target, replaces, files };
  });
}

/** Install every shipped skill from `skillsDir` (the package's skills/) for each agent under `userHome`. */
export function installSkills(skillsDir: string, userHome: string, version: string, opts: { dryRun?: boolean } = {}): SkillInstall[] {
  return SHIPPED_SKILLS.flatMap((skill) => installSkill(path.join(skillsDir, skill), skillTargets(userHome, skill), version, opts));
}

/** Every file under `dir`, relative to it, with / separators. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** One agent's copy of each shipped skill as doctor reports it: absent, written by this Laisso, or by another (null when unstamped). */
export interface SkillStatus extends SkillTarget {
  state: "missing" | "current" | "other";
  installed: string | null;
}

export function skillStatus(userHome: string, version: string): SkillStatus[] {
  return SHIPPED_SKILLS.flatMap((skill) => skillTargets(userHome, skill)).map((target) => {
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
