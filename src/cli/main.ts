import { parseArgs } from "node:util";
import { serve } from "../server/serve.ts";
import { status } from "./status.ts";

export const DEFAULT_PORT = 7433;

const USAGE = `usage:
  lasso                 start the Lasso process (dashboard, tick, Sessions)
  lasso status [ticket] print the ledger, or one Ticket's detail
options:
  --port <n>   port for the server, or the server to talk to
  --json       machine-readable output for client commands
  --all        include done and abandoned Tickets in status`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const portFlag = values.port !== undefined ? Number(values.port) : undefined;
  if (portFlag !== undefined && !Number.isInteger(portFlag)) {
    console.error(`--port must be an integer, got ${String(values.port)}`);
    return 1;
  }
  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      return serve({ portFlag });
    case "status":
      return status({ portFlag, json: Boolean(values.json), all: Boolean(values.all), ticket: rest[0] });
    default:
      console.error(`unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}
