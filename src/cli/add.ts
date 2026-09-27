import { createInterface } from "node:readline/promises";
import { createClient } from "./client.ts";
import type { Detection } from "../intake/detect.ts";
import type { IntakeResult } from "../api/views.ts";

export interface AddOptions {
  portFlag?: number;
  input: string;
  yes: boolean;
  json: boolean;
  repo?: string;
  pipeline?: string;
}

/** `lasso add`: server-side detection, one confirmation, then the new Ticket's id, name, and URL. */
export async function add(opts: AddOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    const input = opts.input.trim();
    if (!input) throw new Error("usage: lasso add <reference | prompt>");
    const detection = await client.post<Detection>("/api/intake/detect", { input, repo: opts.repo });
    const say = opts.json ? console.error : console.log;
    say(`${detection.kind}${detection.reference ? ` ${detection.reference}` : ""}: ${detection.title ?? input}`);

    let repo = opts.repo ?? detection.repo.suggestion ?? undefined;
    if (!repo) {
      if (opts.yes) throw new Error(`repo is ambiguous: pass --repo <${detection.repo.choices.join("|")}>`);
      repo = await ask(`repo [${detection.repo.choices.join("/")}]: `);
      if (!repo) throw new Error("repo is ambiguous: no repo chosen");
    }
    // The Pipeline default follows the repo, so it is settled only once the repo is.
    const pipeline = opts.pipeline ?? detection.pipeline.byRepo[repo] ?? detection.pipeline.suggestion;
    say(`repo: ${repo}`);
    say(`pipeline: ${pipeline}`);
    // A reference's branch is only known once the repo is; ask again when the picker chose it.
    const settled = detection.branch || !detection.reference ? detection : await client.post<Detection>("/api/intake/detect", { input, repo });
    if (settled.branch) say(`branch: ${settled.branch.name}`);
    for (const note of settled.notes) say(note);

    if (!opts.yes) {
      const answer = await ask("intake this Ticket? [y/N] ");
      if (!/^y(es)?$/i.test(answer)) {
        console.error("cancelled");
        return 1;
      }
    }

    const ticket = await client.post<IntakeResult>("/api/tickets", { input, repo, pipeline });
    if (opts.json) {
      console.log(JSON.stringify(ticket, null, 2));
      return 0;
    }
    console.log(`${ticket.id}  ${ticket.title}`);
    console.log(ticket.url);
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
