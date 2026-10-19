import { createClient } from "./client.ts";
import type { PrView } from "../api/views.ts";

export interface PrOptions {
  portFlag?: number;
  /** link, unlink or list. */
  action?: string;
  /** The PR, for link and unlink. */
  pr?: string;
  /** The Ticket as `lasso status` takes it; $LASSO_TICKET when not given. */
  ticket?: string;
  referenced: boolean;
  json: boolean;
}

const USAGE = "usage: lasso pr link <pr> [ticket] [--referenced] | lasso pr unlink <pr> [ticket] | lasso pr list [ticket] [--json]";

/** `lasso pr link | unlink | list`: a Ticket's PR links, by the Ticket named or the Session's own. */
export async function pr(opts: PrOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    if (opts.action !== "link" && opts.action !== "unlink" && opts.action !== "list") throw new Error(USAGE);
    if (opts.action !== "list" && !opts.pr) throw new Error(USAGE);
    const ticket = opts.ticket ?? process.env.LASSO_TICKET;
    if (!ticket) throw new Error("no Ticket: name one, or run inside a Session, where $LASSO_TICKET names it");
    const route = `/api/tickets/${encodeURIComponent(ticket)}/prs`;
    if (opts.action === "list") {
      const prs = await client.get<PrView[]>(route);
      if (opts.json) console.log(JSON.stringify(prs, null, 2));
      else console.log(prs.length ? renderPrs(prs) : "no PRs linked");
      return 0;
    }
    if (opts.action === "link") {
      const link = await client.post<PrView>(route, { pr: opts.pr, role: opts.referenced ? "referenced" : "owned" });
      if (opts.json) console.log(JSON.stringify(link, null, 2));
      else console.log(`linked #${link.number} as ${link.role}: ${link.title} (${stateWord(link)})\n${link.url}`);
      return 0;
    }
    const gone = await client.delete<PrView>(route, { pr: opts.pr });
    if (opts.json) console.log(JSON.stringify(gone, null, 2));
    else console.log(`unlinked #${gone.number}: ${gone.title}\n${gone.url}`);
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** One row per PR: role, who linked it, state, number and title, in the order they were linked. */
function renderPrs(prs: PrView[]): string {
  const rows = prs.map((p) => [p.role, p.source, stateWord(p), `#${p.number}`, p.title]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function stateWord(p: PrView): string {
  return p.state?.toLowerCase() ?? "unknown";
}
