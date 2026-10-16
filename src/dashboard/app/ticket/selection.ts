import type { SessionView, TicketDetail } from "../../../api/views.ts";
import type { Selection } from "../route.ts";

/** What the Session pane shows for a selection. */
export interface Shown {
  /** The Session in the pane: the one selected, the newest of the Stage selected, else the live one; null when there is none. */
  session: SessionView | null;
  /** Whether that is a past Session rather than the live one, so the pane shows it read-only. */
  past: boolean;
  /** A Stage is selected that had no Sessions when it was chosen: the pane says so instead of showing one. */
  empty: boolean;
  /** The Stage the flow and the Sessions list are narrowed to: the one selected, or the selected Session's; null for all. */
  stage: string | null;
  /** The live Session, when it started after the selection was made; the pane stays put and says so. */
  newer: SessionView | null;
}

/**
 * Resolves a selection against a Ticket. The live Session is the Ticket's newest. A selected Stage shows its newest
 * Session as of `baseline`, the live Session's id when the selection was made (null if there was none), so a Session
 * starting later moves nothing and is reported as `newer` instead. A Session id the Ticket lacks, or a Stage its
 * pinned Version lacks, falls back to the live Session, as though nothing were selected.
 */
export function shownSession(t: TicketDetail, select: Selection, baseline: string | null = t.session?.id ?? null): Shown {
  const live = t.session;
  const fallback: Shown = { session: live, past: false, empty: false, stage: null, newer: null };
  if (!select) return fallback;
  // Sessions are newest first, so those the selection knew of run from the baseline on.
  const at = baseline === null ? t.sessions.length : t.sessions.findIndex((s) => s.id === baseline);
  const known = at < 0 ? t.sessions : t.sessions.slice(at);
  const newer = at > 0 ? (live ?? null) : null;
  if ("session" in select) {
    const session = t.sessions.find((s) => s.id === select.session);
    return session ? { session, past: session.id !== live?.id, empty: false, stage: session.stage, newer } : fallback;
  }
  if (!t.stages.some((s) => s.name === select.stage)) return fallback;
  const session = known.find((s) => s.stage === select.stage) ?? null;
  if (!session) return { session: null, past: false, empty: true, stage: select.stage, newer };
  return { session, past: session.id !== live?.id, empty: false, stage: select.stage, newer };
}
