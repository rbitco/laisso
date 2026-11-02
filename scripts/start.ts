// `pnpm start`: Laisso from source, in the dev clone's own Laisso home and port (scripts/dev-env.ts).
//
//   pnpm start [command] [options]

import { homedir } from "node:os";
import { devEnv, laissoArgs } from "./dev-env.ts";

Object.assign(process.env, devEnv(process.env, homedir()));
process.argv.splice(2, Infinity, ...laissoArgs(process.argv.slice(2)));
await import("../bin/laisso.js");
