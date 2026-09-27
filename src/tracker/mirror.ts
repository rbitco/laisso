import type { Config } from "../server/config.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Pipeline } from "../pipeline/load.ts";
import { trackerFor, LABEL_PREFIX, FLAGGED_LABEL, mirrorLabel, type Tracker } from "./tracker.ts";

export interface MirrorDeps {
  config: Config;
  tickets: Tickets;
  log: Logger;
  /** The Ticket's Pipeline, or null when it cannot be loaded; the stage label then stays as the tracker has it. */
  pipelineFor: (ticket: TicketRow) => Pipeline | null;
}

/** What one push did: nothing to mirror, the tracker now matches, or the tracker still owes the write. */
export type PushResult = "skipped" | "pushed" | "pending";

/**
 * The tracker mirrors Lasso's state summary (ADR 0001, ADR 0005): a
 * `lasso:<stage>` label swapped on each transition and `lasso:flagged`
 * toggled. Writes are write-through: the row is already committed when
 * push runs; a failed push marks the Ticket mirror-pending and the tick
 * retries. Every push sets the whole `lasso:*` set, so hand edits in the
 * tracker are overwritten. Pushes for one Ticket run one after another,
 * each from the row as it stands when its turn comes, so the last write
 * always reflects the latest state.
 */
export class Mirror {
  private deps: MirrorDeps;
  private chains = new Map<string, Promise<PushResult>>();

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  /** The `lasso:*` labels the issue should carry; `stage` null means leave whatever stage label it has. */
  wanted(ticket: TicketRow): { stage: string | null; flagged: boolean; active: boolean } {
    if (ticket.state !== "active") return { stage: null, flagged: false, active: false };
    return { stage: this.labelledStage(ticket), flagged: ticket.flagged_at !== null, active: true };
  }

  /** Push the Ticket's labels now, after any push already under way for it; on failure remember it as pending. Never throws. */
  push(ticketId: string): Promise<PushResult> {
    const previous = this.chains.get(ticketId) ?? Promise.resolve<PushResult>("skipped");
    const next = previous.then(() => this.pushNow(ticketId));
    this.chains.set(ticketId, next);
    void next.finally(() => {
      if (this.chains.get(ticketId) === next) this.chains.delete(ticketId);
    });
    return next;
  }

  private async pushNow(ticketId: string): Promise<PushResult> {
    const ticket = this.deps.tickets.get(ticketId);
    if (!ticket?.reference) return "skipped";
    const tracker = this.trackerOf(ticket);
    if (!tracker) return "skipped";
    const wanted = this.wanted(ticket);
    try {
      const labels = await sync(tracker, ticket.reference, wanted);
      if (ticket.mirror_pending) this.deps.tickets.setMirrorPending(ticket.id, null);
      this.deps.log.info("mirror.pushed", { ticket: ticket.id, labels: labels.join(",") });
      return "pushed";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.tickets.setMirrorPending(ticket.id, new Date().toISOString());
      this.deps.log.warn("mirror.pending", { ticket: ticket.id, error: detail });
      return "pending";
    }
  }

  /** The tick's share: every Ticket with a pending mirror is pushed again from its current state. */
  async retryPending(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (const ticket of this.deps.tickets.list({ all: true })) {
      if (!ticket.mirror_pending) continue;
      const result = await this.push(ticket.id);
      if (result === "skipped") continue;
      changes.push({ ticket: ticket.id, summary: result === "pushed" ? "mirror pushed" : "tracker labels not written yet" });
    }
    return changes;
  }

  /** At startup every active tracker Ticket is owed a push, so a tracker edited while Lasso was down is overwritten. */
  markAllPending(): void {
    const now = new Date().toISOString();
    for (const ticket of this.deps.tickets.list()) {
      if (ticket.reference && !ticket.mirror_pending && this.trackerOf(ticket)) this.deps.tickets.setMirrorPending(ticket.id, now);
    }
  }

  private trackerOf(ticket: TicketRow): Tracker | null {
    const repo = this.deps.config.repos[ticket.repo];
    return repo ? trackerFor(repo.tracker, repo.project) : null;
  }

  /** Action Stages get no label of their own: the label of the last Runner Stage before it stays; null when the Pipeline cannot say. */
  private labelledStage(ticket: TicketRow): string | null {
    const pipeline = this.deps.pipelineFor(ticket);
    if (!pipeline) return null;
    const index = pipeline.stages.findIndex((s) => s.name === ticket.stage);
    if (index < 0) return null;
    for (let i = index; i >= 0; i--) {
      const stage = pipeline.stages[i]!;
      if (stage.kind === "runner") return stage.name;
    }
    return null;
  }
}

/** Make the issue's `lasso:*` labels match, touching nothing else and writing nothing when they already do; answers with the labels wanted. */
async function sync(tracker: Tracker, reference: string, wanted: ReturnType<Mirror["wanted"]>): Promise<string[]> {
  const current = await tracker.labels(reference);
  const mine = current.filter((l) => l.startsWith(LABEL_PREFIX));
  // Without a Pipeline to consult the stage label is left alone; only the flag is kept true.
  const keep = wanted.active && wanted.stage === null ? mine.filter((l) => l !== FLAGGED_LABEL) : [];
  const labels = [...keep, ...(wanted.stage ? [mirrorLabel(wanted.stage)] : []), ...(wanted.flagged ? [FLAGGED_LABEL] : [])];
  const add = labels.filter((l) => !mine.includes(l));
  const remove = mine.filter((l) => !labels.includes(l));
  if (add.length || remove.length) await tracker.editLabels(reference, { add, remove });
  return labels;
}
