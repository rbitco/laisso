import type { DisplayState, TicketView } from "../../../api/views.ts";

/**
 * The Ledger's state filter (CONTEXT.md: Ledger): which displayed states it hides, kept in this browser. Every state
 * not hidden is shown, so a state a later Laisso adds shows until someone hides it. Done and Abandoned are hidden by
 * default, as the Ledger always hid them; they are read from the server only when shown, and never counted.
 */

/** Every state, in the Ledger's order, under the heading the filter shows it beneath. The headings are labels only. */
export const STATE_GROUPS: { name: string; states: DisplayState[] }[] = [
  { name: "Attention", states: ["flagged", "needs_you", "holding", "ready"] },
  { name: "Working", states: ["running", "queued"] },
  { name: "Waiting", states: ["watching", "quiet"] },
  { name: "Ended", states: ["done", "abandoned"] },
];

export const STATES: DisplayState[] = STATE_GROUPS.flatMap((g) => g.states);

/** The server's wording for each state, repeated here so a state with no Tickets can still be named. */
export const STATE_LABEL: Record<DisplayState, string> = {
  flagged: "Flagged",
  needs_you: "Needs you",
  holding: "Holding",
  ready: "Ready to start",
  running: "Running",
  queued: "Queued",
  watching: "Watching",
  quiet: "Quiet",
  done: "Done",
  abandoned: "Abandoned",
};

export type EndedState = "done" | "abandoned";
export const ENDED: EndedState[] = ["done", "abandoned"];
const isEnded = (s: DisplayState): s is EndedState => s === "done" || s === "abandoned";

export type Hidden = ReadonlySet<DisplayState>;

export const DEFAULT_HIDDEN: Hidden = new Set<DisplayState>(ENDED);

export const FILTER_KEY = "laisso.ledgerHidden";

/** The hidden states this browser kept, or the default when there are none or they cannot be read. Unknown names are dropped. */
export function loadHidden(): Hidden {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw === null) return DEFAULT_HIDDEN;
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return DEFAULT_HIDDEN;
    return new Set(STATES.filter((s) => saved.includes(s)));
  } catch {
    return DEFAULT_HIDDEN;
  }
}

export function saveHidden(hidden: Hidden): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(STATES.filter((s) => hidden.has(s))));
  } catch {
    // Without storage the choice lasts until the page is left.
  }
}

/** The ended states the filter shows, which are the only ones worth reading from the server. */
export function endedShown(hidden: Hidden): EndedState[] {
  return ENDED.filter((s) => !hidden.has(s));
}

export const isShown = (t: TicketView, hidden: Hidden) => !hidden.has(t.display.state);

/** The Tickets the filter lets through, in the order given. */
export function shownTickets(tickets: TicketView[], hidden: Hidden): TicketView[] {
  return tickets.filter((t) => isShown(t, hidden));
}

/** How many active Tickets are in each state. Ended Tickets are never counted. */
export function countActive(tickets: TicketView[]): Partial<Record<DisplayState, number>> {
  const counts: Partial<Record<DisplayState, number>> = {};
  for (const t of tickets) if (!isEnded(t.display.state)) counts[t.display.state] = (counts[t.display.state] ?? 0) + 1;
  return counts;
}

/**
 * What the Ledger says it is leaving out: each hidden active state that holds Tickets, with its count, then Done and
 * Abandoned whenever hidden, uncounted. "Not showing 3 Quiet, Done and Abandoned"; "" when nothing is named.
 */
export function notShowing(hidden: Hidden, counts: Partial<Record<DisplayState, number>>): string {
  const named = STATES.filter((s) => hidden.has(s) && (isEnded(s) || (counts[s] ?? 0) > 0)).map((s) => (isEnded(s) ? STATE_LABEL[s] : `${counts[s]} ${STATE_LABEL[s]}`));
  if (!named.length) return "";
  const list = named.length === 1 ? named[0] : named.slice(0, -1).join(", ") + " and " + named.at(-1);
  return "Not showing " + list;
}

/** The button's words: "All states", or how many of them show. */
export function filterLabel(hidden: Hidden): string {
  const shown = STATES.filter((s) => !hidden.has(s)).length;
  return shown === STATES.length ? "All states" : `${shown} of ${STATES.length} states`;
}
