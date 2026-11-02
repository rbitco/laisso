// A dev clone's own Laisso home and port, so `pnpm start` and `pnpm dev` run beside the installed Laisso (~/.laisso
// on 7433) without touching its store: ~/.laisso-dev, or LAISSO_DIRECTORY_NAME's name with -dev. scripts/start.ts
// applies them to the Laisso it runs; vite.config.ts to the port `pnpm dev` forwards /api to. An explicit LAISSO_HOME or LAISSO_PORT wins, to point dev at a home on purpose.

import path from "node:path";
import { homeDirName } from "../src/legacy.ts";

export const DEV_PORT = "7434";

/** LAISSO_HOME and LAISSO_PORT for a dev run: each as `env` has it, or the dev default where it is unset or empty. */
export function devEnv(env: NodeJS.ProcessEnv, homedir: string): { LAISSO_HOME: string; LAISSO_PORT: string } {
  return {
    LAISSO_HOME: env.LAISSO_HOME || path.join(homedir, `${homeDirName(env)}-dev`),
    LAISSO_PORT: env.LAISSO_PORT || DEV_PORT,
  };
}

/** Laisso's arguments from a pnpm script's: pnpm passes a `--` through as given, so `pnpm start -- status` works too. */
export function laissoArgs(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}
