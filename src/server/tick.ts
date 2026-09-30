import type { Logger } from "./log.ts";

export interface TickChange {
  ticket: string;
  summary: string;
}

export interface TickResult {
  at: string;
  changes: TickChange[];
}

export interface TickStatus {
  tickSeconds: number;
  lastTick: string | null;
  nextTick: string | null;
  running: boolean;
}

/** What started a tick; the log records it. A Session ending kicks one so the next Stage starts at once. */
export type Trigger = "timer" | "check-now" | "startup" | "start" | "session-end";

/**
 * The global tick: the one clock Lasso runs on. Every poll of a PR, every
 * pending mirror retry, every queued Session start happens inside a tick.
 * Check now runs one immediately; the timer runs one every `tickSeconds`.
 */
export class Tick {
  private lastTick: Date | null = null;
  private nextDue: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TickResult> | null = null;
  /** Set by stop(): a kick after shutdown begins starts nothing. */
  private halted = false;

  private tickSeconds: number;
  private log: Logger;
  private work: () => Promise<TickChange[]>;

  private changed: () => void;

  /** `changed` hears whenever `status()` would answer differently: a tick starting or ending, or the timer starting or stopping. */
  constructor(tickSeconds: number, log: Logger, work: () => Promise<TickChange[]>, changed: () => void = () => undefined) {
    this.tickSeconds = tickSeconds;
    this.log = log;
    this.work = work;
    this.changed = changed;
  }

  start(): void {
    this.halted = false;
    const interval = this.tickSeconds * 1000;
    this.nextDue = new Date(Date.now() + interval);
    this.timer = setInterval(() => {
      this.nextDue = new Date(Date.now() + interval);
      void this.run("timer");
    }, interval);
    this.timer.unref();
    this.changed();
  }

  stop(): void {
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextDue = null;
    this.changed();
  }

  /** Run one tick now; a tick already in flight is joined, not doubled. */
  run(trigger: Trigger = "check-now"): Promise<TickResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const started = new Date();
      let changes: TickChange[] = [];
      try {
        changes = await this.work();
      } catch (error) {
        this.log.error("tick.failed", { error: error instanceof Error ? error.message : String(error) });
      }
      this.lastTick = started;
      this.log.info("tick", { trigger, changes: changes.length, ms: Date.now() - started.getTime() });
      return { at: started.toISOString(), changes };
    })().finally(() => {
      this.inFlight = null;
      this.changed();
    });
    this.changed();
    return this.inFlight;
  }

  /**
   * Run a tick once any tick in flight is through. A Session that ends asks
   * for this, so its Ticket's next Stage starts now rather than on the timer;
   * a tick already running may have looked at the Ticket before it moved.
   */
  kick(trigger: Trigger): void {
    if (this.halted) return;
    void this.settle().then(() => (this.halted ? undefined : this.run(trigger)));
  }

  /** Resolves once any tick in flight is through; at once when none is. Shutdown waits on this so nothing starts after the Sessions are killed. */
  settle(): Promise<void> {
    return this.inFlight ? this.inFlight.then(() => undefined) : Promise.resolve();
  }

  status(): TickStatus {
    return {
      tickSeconds: this.tickSeconds,
      lastTick: this.lastTick?.toISOString() ?? null,
      nextTick: this.nextDue?.toISOString() ?? null,
      running: this.inFlight !== null,
    };
  }
}
