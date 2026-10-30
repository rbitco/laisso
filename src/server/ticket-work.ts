import type { Logger } from "./log.ts";
import type { TickChange } from "./tick.ts";

/** How long a tick waits on one Ticket's work before leaving it to finish on its own. */
export const TICK_PATIENCE_MS = 5_000;

export interface TicketWorkOptions {
  /** The tick step this is, as the log names it: review, mirror, watch, sweep. */
  step: string;
  /** At most this many Tickets' work at once; the rest wait their turn, so a poll stays inside GitHub's limits. */
  limit: number;
  log: Logger;
  /** How long a tick waits on one Ticket's work; TICK_PATIENCE_MS unless a test says otherwise. */
  patienceMs?: number;
  /** Called when work that outlasted its tick ends having changed something; serve kicks a tick so what it made due starts now. */
  late?: () => void;
}

interface Job {
  ticket: string;
  done: Promise<TickChange[]>;
  finished: boolean;
  late: boolean;
}

/**
 * One tick step run for each Ticket on its own (LASSO-203). A Ticket whose
 * work from an earlier tick is still running is skipped, so a hung gh, git
 * or Action delays only its own Ticket. The tick waits on each Ticket's work
 * up to its patience; work that runs longer goes on in the background, is
 * logged when it ends, and calls `late` when it changed something.
 */
export class TicketWork {
  private options: TicketWorkOptions;
  private running = new Map<string, Job>();
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(options: TicketWorkOptions) {
    this.options = options;
  }

  /** Is this Ticket's work from an earlier tick still running? */
  busy(ticket: string): boolean {
    return this.running.has(ticket);
  }

  /** Run `work` for each Ticket not still busy; the changes of the work that finished within the tick's patience, in Ticket order. */
  async run(tickets: string[], work: (ticket: string) => Promise<TickChange[]>): Promise<TickChange[]> {
    const jobs: Job[] = [];
    for (const ticket of tickets) {
      if (this.running.has(ticket)) {
        this.options.log.warn("tick.ticket_busy", { step: this.options.step, ticket });
        continue;
      }
      jobs.push(this.start(ticket, work));
    }
    return (await Promise.all(jobs.map((job) => this.within(job)))).flat();
  }

  /** Resolves once every Ticket's work is through, late work included; shutdown waits on this before killing Sessions. */
  async settle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()].map((job) => job.done));
  }

  private start(ticket: string, work: (ticket: string) => Promise<TickChange[]>): Job {
    const { step, log } = this.options;
    const done = this.slot(() => work(ticket)).catch((error: unknown) => {
      log.error("tick.ticket_failed", { step, ticket, error: error instanceof Error ? error.message : String(error) });
      return [] as TickChange[];
    });
    const job: Job = { ticket, done, finished: false, late: false };
    this.running.set(ticket, job);
    void done.then((changes) => {
      job.finished = true;
      this.running.delete(ticket);
      if (!job.late) return;
      log.info("tick.late_work", { step, ticket, changes: changes.map((c) => c.summary).join("; ") || null });
      if (changes.length) this.options.late?.();
    });
    return job;
  }

  /** The job's changes, or none once the patience runs out; the job is then late and reports itself when it ends. */
  private within(job: Job): Promise<TickChange[]> {
    const patienceMs = this.options.patienceMs ?? TICK_PATIENCE_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (job.finished) return;
        job.late = true;
        this.options.log.warn("tick.work_overran", { step: this.options.step, ticket: job.ticket, ms: patienceMs });
        resolve([]);
      }, patienceMs);
      void job.done.then((changes) => {
        clearTimeout(timer);
        if (!job.late) resolve(changes);
      });
    });
  }

  private async slot<T>(act: () => Promise<T>): Promise<T> {
    while (this.active >= this.options.limit) await new Promise<void>((resume) => this.waiting.push(resume));
    this.active++;
    try {
      return await act();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
