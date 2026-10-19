import { parseArgs } from "node:util";
import { serve } from "../server/serve.ts";
import { status } from "./status.ts";
import { add } from "./add.ts";
import { check } from "./check.ts";
import { pr as prCommand } from "./pr.ts";
import { doctor } from "./doctor.ts";
import { skill } from "./skill.ts";

export const DEFAULT_PORT = 7433;

const USAGE = `usage:
  lasso                     start the Lasso process (dashboard, tick, Sessions)
  lasso add <ref | prompt>  intake a tracker reference or a prompt as a Ticket
  lasso status [ticket]     print the Ledger, or one Ticket's detail
  lasso check [ticket]      run a tick now and print what changed
  lasso pr link <pr> [ticket]    link a PR to a Ticket (URL, owner/repo#N, #N or N)
  lasso pr unlink <pr> [ticket]  unlink a PR; the Tick won't link it again
  lasso pr list [ticket]         list a Ticket's PRs; the Ticket defaults to $LASSO_TICKET
  lasso doctor              list the tools Lasso needs, whether each is found and logged in
  lasso skill install       copy the Lasso skill to where Claude Code and Codex look for skills
options:
  --port <n>       port for the server, or the server to talk to
  --json           machine-readable output for client commands
  --all            include done and abandoned Tickets in status
  --yes            add: accept the suggestions without asking
  --repo <name>    add: the repo to intake into
  --pipeline <n>   add: the Pipeline to run
  --referenced     pr link: link for context only, not as the Ticket's own work
  --dry-run        skill install: print what would be written, write nothing`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      repo: { type: "string" },
      pipeline: { type: "string" },
      referenced: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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
    case "add":
      return add({
        portFlag,
        input: rest.join(" "),
        yes: Boolean(values.yes),
        json: Boolean(values.json),
        repo: typeof values.repo === "string" ? values.repo : undefined,
        pipeline: typeof values.pipeline === "string" ? values.pipeline : undefined,
      });
    case "status":
      return status({ portFlag, json: Boolean(values.json), all: Boolean(values.all), ticket: rest[0] });
    case "check":
      return check({ portFlag, json: Boolean(values.json), ticket: rest[0] });
    case "pr": {
      // list takes only the Ticket; link and unlink take the PR first.
      const [action, ...args] = rest;
      const [pr, ticket] = action === "list" ? [undefined, args[0]] : args;
      return prCommand({ portFlag, action, pr, ticket, referenced: Boolean(values.referenced), json: Boolean(values.json) });
    }
    case "doctor":
      return doctor({ json: Boolean(values.json) });
    case "skill":
      return skill({ action: rest[0], dryRun: Boolean(values["dry-run"]), json: Boolean(values.json) });
    default:
      console.error(`unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}
