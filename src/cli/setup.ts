import { spawn } from "node:child_process";
import { ensureHome, resolveHome } from "../server/home.ts";
import { migrateHome } from "../server/migrate.ts";
import { ConfigError, loadConfig } from "../server/config.ts";
import { findOnPath } from "../tools/tools.ts";
import { installSetupSkill, setupCommand, SetupError, type SetupCommand } from "../setup/command.ts";

export interface SetupOptions {
  /** The Agent Profile to run setup under; default_profile when not given. */
  profile?: string;
  /** LAISSO_HOME, PATH and HOME are read from here: the process's own unless a test says otherwise. */
  env?: NodeJS.ProcessEnv;
}

/**
 * `laisso setup`: make the Laisso home if it is new, install the Laisso skills,
 * then run the profile's Runner here in this terminal, in the home, on a
 * prompt that starts the laisso-setup skill: the walkthrough of repos, Pipelines and the rest. Needs
 * no running Laisso; answers with the Runner's exit code.
 */
export async function setup(opts: SetupOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const home = resolveHome(env);
  let setup: SetupCommand;
  try {
    ensureHome(home, env);
    migrateHome(home);
    setup = setupCommand(home, loadConfig(home), opts.profile);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SetupError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const { command, profile } = setup;
  const [bin, ...args] = command.argv as [string, ...string[]];
  if (findOnPath(env)(bin) === null) {
    console.error(`${bin} is not on PATH: install it, or pass --profile <name> for a profile whose Runner you have`);
    return 1;
  }
  for (const target of installSetupSkill(env)) console.log(`installed the ${target.skill} skill for ${target.agent} in ${target.dir}`);
  console.log(`setting up ${home.root} with ${bin} (profile ${profile})`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: command.cwd, env: { ...env, ...command.env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
