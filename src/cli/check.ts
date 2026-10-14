import { createClient } from "./client.ts";
import type { TickResult } from "../server/tick.ts";
import type { TicketView } from "../api/views.ts";

export interface CheckOptions {
  portFlag?: number;
  json: boolean;
  ticket?: string;
}

/** `lasso check [ticket]`: run a tick now and print one line per Ticket it changed, or "nothing new". */
export async function check(opts: CheckOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    const only = opts.ticket ? await client.get<TicketView>(`/api/tickets/${encodeURIComponent(opts.ticket)}`) : null;
    const result = await client.post<TickResult>("/api/check-now");
    const changes = only ? result.changes.filter((c) => c.ticket === only.id) : result.changes;
    if (opts.json) {
      console.log(JSON.stringify({ ...result, changes }, null, 2));
      return 0;
    }
    if (changes.length === 0) {
      console.log("nothing new");
      return 0;
    }
    const tickets = await client.get<TicketView[]>("/api/tickets?all=1");
    console.log(renderChanges(changes, tickets));
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** One line per changed Ticket, its summaries in tick order. */
export function renderChanges(changes: TickResult["changes"], tickets: TicketView[]): string {
  const byTicket = new Map<string, string[]>();
  for (const change of changes) byTicket.set(change.ticket, [...(byTicket.get(change.ticket) ?? []), change.summary]);
  return [...byTicket]
    .map(([id, summaries]) => {
      const ticket = tickets.find((t) => t.id === id);
      return `${ticket?.label ?? id}  ${summaries.join("; ")}`;
    })
    .join("\n");
}
