import { homedir } from "node:os";
import type { Config } from "../server/config.ts";
import { settingsFor } from "../server/config.ts";
import type { LaissoHome } from "../server/home.ts";
import type { Command } from "../runner/adapter.ts";
import { adapterFor } from "../runner/adapters.ts";
import { findPackageRoot } from "../package-root.ts";
import { installSkills, type SkillInstall } from "../skill/skill.ts";
import { setupPrompt } from "./prompt.ts";

export class SetupError extends Error {}

/** How setup runs: the Runner's interactive launch in the home, and the profile it runs under. */
export interface SetupCommand {
  command: Command;
  profile: string;
}

/**
 * The Runner `laisso setup` launches: the named profile's, else default_profile's, as its human Sessions run it, in
 * the Laisso home, on the setup prompt. Throws SetupError naming the profiles there are when none fits.
 */
export function setupCommand(home: LaissoHome, config: Config, profileName?: string): SetupCommand {
  const name = profileName ?? config.default_profile;
  const profile = name ? config.profiles[name] : undefined;
  if (!name || !profile) {
    const known = Object.keys(config.profiles).join(", ") || "none";
    throw new SetupError(name ? `no profile named ${name} in config.yaml (profiles: ${known})` : `config.yaml has no default_profile: pass --profile <${known}>`);
  }
  const prompt = setupPrompt({ home, skillsDir: findPackageRoot().skillsDir, port: config.port });
  return { command: adapterFor(profile.runner).interactive(prompt, settingsFor(profile, "human"), home.root), profile: name };
}

/** Install the skills this package ships for each agent under the user's home: laisso-setup for setup itself, laisso for the Stages set up next. */
export function installSetupSkill(env: NodeJS.ProcessEnv): SkillInstall[] {
  const pkg = findPackageRoot();
  return installSkills(pkg.skillsDir, env.HOME || homedir(), pkg.version);
}
