import type { SessionView, TicketDetail } from "../../../api/views.ts";
import type { Selection } from "../route.ts";

/** What the Session pane shows for a selection. */
export interface Shown {
  /** The Session in the pane: the one selected, the newest of the Stage selected, else the live one; null when there is none. */
  session: SessionView | null;
  /** Whether that is a past Session rather than the live one, so the pane shows it read-only. */
  past: boolean;
  /** The Stage the flow and the Sessions list are narrowed to: the one selected, or the selected Session's; null for all. */
  stage: string | null;
}

/**
 * Resolves a selection against a Ticket. The live Session is the Ticket's newest. A selected Stage shows its newest
 * Session, its Sessions being newest first like the Ticket's. A Session id the Ticket lacks, or a Stage its pinned
 * Version lacks, falls back to the live Session, as though nothing were selected.
 */
export function shownSession(t: TicketDetail, select: Selection): Shown {
  const live = t.session;
  const fallback: Shown = { session: live, past: false, stage: null };
  if (!select) return fallback;
  if ("session" in select) {
    const session = t.sessions.find((s) => s.id === select.session);
    return session ? { session, past: session.id !== live?.id, stage: session.stage } : fallback;
  }
  if (!t.stages.some((s) => s.name === select.stage)) return fallback;
  const session = t.sessions.find((s) => s.stage === select.stage) ?? null;
  return { session: session ?? live, past: session !== null && session.id !== live?.id, stage: select.stage };
}
