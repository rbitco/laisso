// `pnpm start`: Lasso from source, in the dev clone's own Lasso home and port (scripts/dev-env.ts).
//
//   pnpm start [command] [options]

import { homedir } from "node:os";
import { devEnv, lassoArgs } from "./dev-env.ts";

Object.assign(process.env, devEnv(process.env, homedir()));
process.argv.splice(2, Infinity, ...lassoArgs(process.argv.slice(2)));
await import("../bin/lasso.js");
