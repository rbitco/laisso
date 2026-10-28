import { createClient } from "./client.ts";
import type { RoutePickView } from "../api/views.ts";

export interface RouteOptions {
  portFlag?: number;
  /** The Route to pick; absent with `clear`. */
  name?: string;
  note?: string;
  clear: boolean;
  json: boolean;
}

const USAGE = 'usage: lasso route <name> [--note "..."] | lasso route --clear';

/**
 * `lasso route <name> | --clear`: the running Session picks the Route its Stage leaves by, or drops its pick.
 * The Session is $LASSO_SESSION, sent as the client sends it on every call; the last call in a run wins.
 */
export async function route(opts: RouteOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    if (opts.clear === Boolean(opts.name) || (opts.clear && opts.note !== undefined)) throw new Error(USAGE);
    if (!process.env.LASSO_SESSION) throw new Error("lasso route runs inside a Session, where $LASSO_SESSION names it");
    const pick = await client.post<RoutePickView>("/api/route", { route: opts.clear ? null : opts.name, ...(opts.note !== undefined ? { note: opts.note } : {}) });
    if (opts.json) console.log(JSON.stringify(pick, null, 2));
    else console.log(pick.route ? `picked Route ${pick.route} to ${pick.to}${pick.note ? `: ${pick.note}` : ""}` : `no Route picked on ${pick.stage}; it walks forward`);
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
