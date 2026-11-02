import { parseArgs } from "node:util";
import { serve } from "../server/serve.ts";
import { status } from "./status.ts";
import { add } from "./add.ts";
import { check } from "./check.ts";
import { pr as prCommand } from "./pr.ts";
import { route } from "./route.ts";
import { doctor } from "./doctor.ts";
import { skill } from "./skill.ts";
import { setup } from "./setup.ts";

export const DEFAULT_PORT = 7433;

const USAGE = `usage:
  laisso                     start the Laisso process (dashboard, tick, Sessions)
  laisso setup               set up repos and Pipelines with a coding agent, here in this terminal
  laisso add <ref | prompt>  intake a tracker reference or a prompt as a Ticket
  laisso add <prompt> --pr <pr> --pipeline pr-review
                            review a teammate's PR; the findings land in the worktree
  laisso status [ticket]     print the Ledger, or one Ticket's detail
  laisso check [ticket]      run a tick now and print what changed
  laisso pr link <pr> [ticket]    link a PR to a Ticket (URL, owner/repo#N, #N or N)
  laisso pr unlink <pr> [ticket]  unlink a PR; the Tick won't link it again
  laisso pr list [ticket]         list a Ticket's PRs; the Ticket defaults to $LAISSO_TICKET
  laisso route <name> [--note "..."]  in an Action: leave the Stage by that Route if it exits 0
  laisso route --clear            in an Action: drop the Route picked, so the Ticket walks forward
  laisso doctor              list the tools Laisso needs, whether each is found and logged in
  laisso skill install       copy the Laisso skill to where Claude Code and Codex look for skills
options:
  --port <n>       port for the server, or the server to talk to
  --json           machine-readable output for client commands
  --all            include done and abandoned Tickets in status
  --yes            add: accept the suggestions without asking
  --repo <name>    add: the repo to intake into
  --pipeline <n>   add: the Pipeline to run
  --pr <pr>        add: link a PR as Referenced (repeatable); without --repo, its repo is the Ticket's
  --referenced     pr link: link for context only, not as the Ticket's own work
  --note <text>    route: why, for the Stage the Route goes to; else the run's last line of output
  --clear          route: drop the Route picked
  --dry-run        skill install: print what would be written, write nothing
  --profile <n>    setup: the Agent Profile to run it under; default_profile otherwise`;

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
      pr: { type: "string", multiple: true },
      referenced: { type: "boolean", default: false },
      note: { type: "string" },
      clear: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      profile: { type: "string" },
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
        prs: Array.isArray(values.pr) ? values.pr.filter((p): p is string => typeof p === "string") : [],
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
    case "route":
      return route({ portFlag, name: rest[0], note: typeof values.note === "string" ? values.note : undefined, clear: Boolean(values.clear), json: Boolean(values.json) });
    case "doctor":
      return doctor({ json: Boolean(values.json) });
    case "setup":
      return setup({ profile: typeof values.profile === "string" ? values.profile : undefined });
    case "skill":
      return skill({ action: rest[0], dryRun: Boolean(values["dry-run"]), json: Boolean(values.json) });
    default:
      console.error(`unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}
