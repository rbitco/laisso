import { homedir } from "node:os";
import { findPackageRoot } from "../package-root.ts";
import { installSkill, skillTargets, SkillMissing, type SkillInstall } from "../skill/skill.ts";

export interface SkillOptions {
  action?: string;
  dryRun: boolean;
  json: boolean;
  /** The user's home the skill is installed under; the real one unless a test says otherwise. */
  userHome?: string;
}

/**
 * `lasso skill install`: copy the Lasso skill this package ships into
 * ~/.claude/skills/lasso, and ~/.codex/skills/lasso when Codex is there,
 * stamped with this Lasso's version. Needs no running Lasso.
 */
export async function skill(opts: SkillOptions): Promise<number> {
  if (opts.action !== "install") {
    console.error("usage: lasso skill install [--dry-run] [--json]");
    return 1;
  }
  const pkg = findPackageRoot();
  let installs: SkillInstall[];
  try {
    installs = installSkill(pkg.skillDir, skillTargets(opts.userHome ?? homedir()), pkg.version, { dryRun: opts.dryRun });
  } catch (error) {
    if (error instanceof SkillMissing) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, source: pkg.skillDir, dryRun: opts.dryRun, targets: installs }, null, 2));
    return 0;
  }
  console.log(renderInstall(installs, pkg.version, opts.dryRun));
  return 0;
}

/** Per target: what it replaces and the files written, or would be with --dry-run. */
export function renderInstall(installs: SkillInstall[], version: string, dryRun: boolean): string {
  return installs
    .map((i) => {
      const head = dryRun
        ? `would ${i.replaces ? "replace" : "write"} ${i.dir} (${i.agent}) with the skill from Lasso ${version}:`
        : `${i.replaces ? "replaced" : "wrote"} ${i.dir} (${i.agent}) with the skill from Lasso ${version}:`;
      return [head, ...i.files.map((f) => `  ${f}`)].join("\n");
    })
    .join("\n\n");
}
