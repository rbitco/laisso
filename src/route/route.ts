import type { Stage } from "../pipeline/load.ts";
import type { ChosenBy } from "../store/visits.ts";

/**
 * How a Ticket leaves a Stage (CONTEXT.md: Route; LASSO-188). Pure: callers
 * gather the Stage, the Visit's pick and how the run ended, and act on the
 * Exit it returns, so no caller re-derives a rule of its own.
 */

/** A Route picked for leaving the Stage on the current Visit, with its note and who picked it. */
export interface RoutePick {
  route: string;
  /** The `--note` given; null or blank leaves the note to the run's last line. */
  note: string | null;
  by: ChosenBy;
}

/** How the run that would have the Ticket leave the Stage ended. */
export interface RunEnd {
  /** It ended as one that otherwise advances: an Action that exited 0. */
  succeeded: boolean;
  /** Its last non-empty line of output (an Action's Latest Message), the note when the pick gives none. */
  lastLine: string | null;
}

export interface Leaving {
  /** The Stage being left, with its Routes. */
  stage: Stage;
  /** The current Visit's pick, or null when nothing picked one. */
  pick: RoutePick | null;
  end: RunEnd;
}

/** The Ticket takes a Route: the Visit it starts at `to` records these. */
export interface TakeRoute {
  kind: "route";
  route: string;
  to: string;
  /** The Route's append or replace text, null when it has neither. */
  text: string | null;
  /** The text replaces the target's prompt text rather than following it. */
  replaces: boolean;
  note: string | null;
  chosenBy: ChosenBy;
}

/**
 * Where the Ticket goes: walk forward to the next Stage as before Routes,
 * take a Route, or Flag `outcome.failed` because the run failed, naming the
 * pick that was not taken.
 */
export type Exit = { kind: "walk" } | TakeRoute | { kind: "failed"; untaken: RoutePick | null };

/**
 * An Action's pick is taken only when it exits 0; a failed run Flags as it
 * always has, with the pick shown but not taken. No pick walks forward. A
 * pick the Stage does not declare cannot be recorded (`lasso route` checks
 * the name), so one met here is ignored and the Ticket walks forward.
 */
export function decide({ stage, pick, end }: Leaving): Exit {
  if (!end.succeeded) return { kind: "failed", untaken: pick };
  const route = pick ? stage.routes?.[pick.route] : undefined;
  if (!pick || !route) return { kind: "walk" };
  const note = pick.note?.trim() || end.lastLine?.trim() || null;
  return {
    kind: "route",
    route: pick.route,
    to: route.to,
    text: route.replace ?? route.append ?? null,
    replaces: route.replace !== undefined,
    note,
    chosenBy: pick.by,
  };
}
