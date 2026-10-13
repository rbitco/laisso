// A dev clone's own Lasso home and port, so `pnpm start` and `pnpm dev` run beside the installed Lasso (~/.lasso
// on 7433) without touching its store. scripts/start.ts applies them to the Lasso it runs; vite.config.ts to the
// port `pnpm dev` forwards /api to. An explicit LASSO_HOME or LASSO_PORT wins, to point dev at a home on purpose.

import path from "node:path";

export const DEV_HOME_DIR = ".lasso-dev";
export const DEV_PORT = "7434";

/** LASSO_HOME and LASSO_PORT for a dev run: each as `env` has it, or the dev default where it is unset or empty. */
export function devEnv(env: NodeJS.ProcessEnv, homedir: string): { LASSO_HOME: string; LASSO_PORT: string } {
  return {
    LASSO_HOME: env.LASSO_HOME || path.join(homedir, DEV_HOME_DIR),
    LASSO_PORT: env.LASSO_PORT || DEV_PORT,
  };
}

/** Lasso's arguments from a pnpm script's: pnpm passes a `--` through as given, so `pnpm start -- status` works too. */
export function lassoArgs(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}
