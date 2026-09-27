import { createClient, NotRunning } from "./client.ts";

export interface StatusOptions {
  portFlag?: number;
  json: boolean;
  all: boolean;
  ticket?: string;
}

export async function status(opts: StatusOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    if (opts.ticket) {
      const detail = await client.get<unknown>(`/api/tickets/${encodeURIComponent(opts.ticket)}`);
      console.log(JSON.stringify(detail, null, 2));
      return 0;
    }
    const tickets = await client.get<unknown[]>(`/api/tickets${opts.all ? "?all=1" : ""}`);
    if (opts.json) {
      console.log(JSON.stringify({ tickets }, null, 2));
      return 0;
    }
    if (tickets.length === 0) {
      console.log("no active Tickets");
      return 0;
    }
    console.log(JSON.stringify(tickets, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
