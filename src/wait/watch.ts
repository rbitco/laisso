import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Visits } from "../store/visits.ts";
import type { Progress } from "../session/progress.ts";
import type { ActionChecks } from "../artifact/action-check.ts";
import { actionArtifact, type WaitStage } from "../pipeline/load.ts";
import { parseDuration } from "../duration.ts";

export interface WatchDeps {
  tickets: Tickets;
  visits: Visits;
  progress: Progress;
  checks: ActionChecks;
  log: Logger;
}

/**
 * Wait Stages on the Tick (CONTEXT.md: Watching; LASSO-195). Each Tick, and so
 * on Check now, every Ticket at a wait Stage runs its check, unless it is
 * Flagged, holding, or already has a check of it running. Met, the Ticket leaves
 * by the Route decision, taking the Route the check chose or walking on; not
 * met, it keeps Watching; broken, it Flags `artifact.error`. A Stage with
 * `budget.wallTime` Flags `budget.wall_time` once it has Watched that long.
 * Watching holds no slot and raises no notification of its own.
 */
export class Watch {
  private deps: WatchDeps;

  constructor(deps: WatchDeps) {
    this.deps = deps;
  }

  /** The Tick's pass over wait Stages. Checks of different Tickets run side by side; one line per Ticket that moved or Flagged. */
  async poll(now: number = Date.now()): Promise<TickChange[]> {
    const due: Array<Promise<TickChange | null>> = [];
    for (const ticket of this.deps.tickets.list()) {
      const current = this.deps.progress.current(ticket);
      if ("problem" in current || current.stage.kind !== "wait") continue;
      if (ticket.flagged_at || ticket.holding_since || this.deps.checks.running(ticket.id)) continue;
      const stage = current.stage;
      due.push(
        this.watch(ticket, stage, now).catch((error: unknown) => {
          this.deps.log.error("wait.poll_failed", { ticket: ticket.id, stage: stage.name, error: error instanceof Error ? error.message : String(error) });
          return null;
        }),
      );
    }
    return (await Promise.all(due)).filter((c): c is TickChange => c !== null);
  }

  private async watch(ticket: TicketRow, stage: WaitStage, now: number): Promise<TickChange | null> {
    const { visits, progress, checks, tickets } = this.deps;
    const visit = visits.current(ticket.id);
    if (!visit || visit.stage !== stage.name) return null;
    const over = this.overTime(ticket, stage, visit.arrived_at, now);
    if (over) {
      await progress.flag(ticket.id, "budget.wall_time", over);
      return { ticket: ticket.id, summary: `Flagged: ${over}` };
    }
    const verdict = await checks.probe(ticket, stage.name)(actionArtifact(stage.wait)!, stage.waitWith);
    // The check took a while: a human may have sent the Ticket on, skipped, Flagged or Abandoned it meanwhile. Its
    // result stays on the Visit it ran for, and nothing moves on the Visit that replaced it.
    const fresh = tickets.get(ticket.id);
    if (!fresh || fresh.state !== "active" || fresh.flagged_at || fresh.holding_since || visits.current(ticket.id)?.id !== visit.id) return null;
    if (verdict.present) {
      await progress.advance(fresh);
      return { ticket: ticket.id, summary: `${stage.wait} met; ${stage.name} finished` };
    }
    if (verdict.broken) {
      const detail = `${stage.wait}: ${verdict.detail}`;
      await progress.flag(ticket.id, "artifact.error", detail);
      return { ticket: ticket.id, summary: `Flagged: ${detail}` };
    }
    return null;
  }

  /**
   * Why the Stage has Watched too long, or null. Only a Stage that sets `budget.wallTime` has a limit; the Ticket's
   * wall-time override (Extend) raises it. The clock runs from arrival, or from the last cleared Flag, as a Retry
   * starts a Session's wall time afresh.
   */
  private overTime(ticket: TicketRow, stage: WaitStage, arrivedAt: string, now: number): string | null {
    if (!stage.budget.wallTime) return null;
    const limit = ticket.budget_wall_time ?? stage.budget.wallTime;
    const since = Math.max(new Date(arrivedAt).getTime(), ticket.unflagged_at ? new Date(ticket.unflagged_at).getTime() : 0);
    if (now - since < parseDuration(limit)) return null;
    return `${stage.name}: ${stage.wait} not met within ${limit}`;
  }
}
