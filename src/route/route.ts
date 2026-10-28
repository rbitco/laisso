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
  /** The check run that picked it, for a check's pick. */
  run?: string | null;
}

/** How the run that would have the Ticket leave the Stage ended. */
export interface RunEnd {
  /** It ended as one that otherwise advances: an Action that exited 0. */
  succeeded: boolean;
  /** Its last non-empty line of output (an Action's Latest Message), the note when the pick gives none. */
  lastLine: string | null;
}

/** How often a Route has been taken for the Ticket by an agent, Action or check, and how often it may be. */
export interface RouteCount {
  used: number;
  limit: number;
}

export interface Leaving {
  /** The Stage being left, with its Routes. */
  stage: Stage;
  /** The current Visit's pick by the Stage's own run (its Action or agent), or null when it picked none. */
  pick: RoutePick | null;
  /**
   * The pick of the Stage's check Action, from its latest run only when that run was met; null or absent when it
   * picked none. Its note already falls back to the check's last line.
   */
  check?: RoutePick | null;
  end: RunEnd;
  /** The Stage's Routes by name, each counted and with its resolved limit (the Route Budget). One missing is not capped. */
  counts: Record<string, RouteCount>;
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

/** The Stage's own run and its check picked different Routes: the Ticket is Flagged `route.conflict` showing both. */
export interface Conflict {
  kind: "conflict";
  pick: RoutePick;
  check: RoutePick;
}

/**
 * The Ticket stays at the Stage, Flagged: an agent, Action or check picked a
 * Route whose Budget is spent. `pending` is the Route it would have taken,
 * which Extend takes once the Ticket's Route limit allows it.
 */
export interface RouteFlag {
  kind: "flag";
  reason: "budget.routes";
  detail: string;
  pending: TakeRoute;
}

/**
 * Where the Ticket goes: walk forward to the next Stage as before Routes,
 * take a Route, Flag `route.conflict` when two picks disagree, Flag
 * `budget.routes` for a spent Route, or Flag `outcome.failed` because the
 * run failed, naming the pick that was not taken.
 */
export type Exit = { kind: "walk" } | TakeRoute | Conflict | RouteFlag | { kind: "failed"; untaken: RoutePick | null };

/**
 * An Action's pick is taken only when it exits 0; a failed run Flags as it
 * always has, with the pick shown but not taken. No pick walks forward. A
 * pick the Stage does not declare cannot be recorded (`lasso route` checks
 * the name), so one met here is ignored.
 *
 * When the Stage's own run and its check both pick: one pick, or the same
 * Route, is taken (the run's pick, its note falling back to the check's);
 * different Routes are a conflict for a human to settle.
 *
 * The Route to be taken, whoever picked it, is then held to its Budget: a
 * pick by an agent, Action or check of a Route already taken up to its limit
 * is not taken, and the Ticket Flags `budget.routes` with the Route pending.
 * A human's pick is never counted and never refused.
 */
export function decide({ stage, pick, check = null, end, counts }: Leaving): Exit {
  if (!end.succeeded) return { kind: "failed", untaken: pick };
  const own = declared(stage, pick);
  const checked = declared(stage, check);
  if (own && checked && own.route !== checked.route) return { kind: "conflict", pick: own, check: checked };
  const taken = own ?? checked;
  if (!taken) return { kind: "walk" };
  const route = stage.routes![taken.route]!;
  const note = taken.note?.trim() || (taken === own ? checked?.note?.trim() : null) || end.lastLine?.trim() || null;
  const take: TakeRoute = {
    kind: "route",
    route: taken.route,
    to: route.to,
    text: route.replace ?? route.append ?? null,
    replaces: route.replace !== undefined,
    note,
    chosenBy: taken.by,
  };
  const count = counts[taken.route];
  if (taken.by !== "human" && count && count.used >= count.limit) {
    return { kind: "flag", reason: "budget.routes", detail: `Route ${taken.route} to ${route.to}: ${count.used} of ${count.limit} used; Extend to take it`, pending: take };
  }
  return take;
}


/** The pick when the Stage declares its Route, else null. */
function declared(stage: Stage, pick: RoutePick | null): RoutePick | null {
  return pick && stage.routes?.[pick.route] ? pick : null;
}
