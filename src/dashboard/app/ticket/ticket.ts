import type { TicketDetail, TicketView } from "../../../api/views.ts";
import { api, ApiError } from "../api.ts";

/** Mark done met with a missing artifact: what is missing, and that the Ticket may advance anyway. */
export interface ArtifactProblem {
  artifact: string;
  detail: string;
}

/** A Ticket's own routes start here. */
export const ticketRoute = (id: string) => "/api/tickets/" + encodeURIComponent(id);

/** The sidebar's Tickets, in Ledger order; `all` includes done and Abandoned. */
export const listTickets = (all: boolean) => api<TicketView[]>(all ? "/api/tickets?all=1" : "/api/tickets");

export const readTicket = (id: string) => api<TicketDetail>(ticketRoute(id));

/**
 * Pulls a Trigger on a Ticket, or "check" for Check PR now, which runs a tick. Mark done met with a missing artifact
 * answers with the problem rather than throwing, so the page can offer to advance anyway; null otherwise.
 */
export async function pullTrigger(id: string, action: string, body: object = {}): Promise<ArtifactProblem | null> {
  if (action === "check") {
    await api("/api/check-now", { method: "POST" });
    return null;
  }
  try {
    await api(ticketRoute(id) + "/" + action, { method: "POST", body: JSON.stringify(body) });
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && isOverride(error.body)) return { artifact: error.body.artifact, detail: error.body.detail };
    throw error;
  }
}

const isOverride = (body: unknown): body is ArtifactProblem & { override: true } => !!body && typeof body === "object" && "override" in body && body.override === true;

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
