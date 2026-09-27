import { existsSync } from "node:fs";
import { loadConfig } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import type { Progress } from "./progress.ts";

export interface Runnable {
  ticket: TicketRow;
  pipeline: Pipeline;
  stage: RunnerStage;
}

export interface QueueDeps {
  home: LassoHome;
  tickets: Tickets;
  sessions: Sessions;
  progress: Progress;
  log: Logger;
  /** The `concurrency:` cap as loaded at startup; config.yaml is re-read before each count of free slots. */
  cap: number;
}

/**
 * The line for headless slots (spec: Concurrency). `concurrency:` caps
 * running headless Sessions across all Tickets; terminal Sessions hold no
 * slot. A Ticket joins the line the first tick that finds it runnable and
 * leaves it when a Session starts or Progress moves it on, so the oldest
 * runnable starts first.
 */
export class Queue {
  private deps: QueueDeps;
  private cap: number;
  private lastReloadError: string | null = null;

  constructor(deps: QueueDeps) {
    this.deps = deps;
    this.cap = deps.cap;
  }

  /**
   * Every Ticket the tick could start now, oldest runnable first, and the
   * Tickets whose Pipeline is missing. Joining stamps the Ticket; a Ticket
   * found no longer runnable is unstamped, so a position never counts one
   * that was Flagged or held between ticks.
   */
  runnable(now: string = new Date().toISOString()): { ready: Runnable[]; problems: Array<{ ticket: TicketRow; problem: string }> } {
    const ready: Runnable[] = [];
    const problems: Array<{ ticket: TicketRow; problem: string }> = [];
    for (const ticket of this.deps.tickets.list()) {
      const resolved = this.deps.progress.runnable(ticket);
      if (resolved === null) {
        if (ticket.runnable_since) this.deps.tickets.setRunnableSince(ticket.id, null);
        continue;
      }
      if ("problem" in resolved) {
        problems.push({ ticket, problem: resolved.problem });
        continue;
      }
      if (!ticket.runnable_since) {
        this.deps.tickets.setRunnableSince(ticket.id, now);
        ticket.runnable_since = now;
      }
      ready.push({ ticket, ...resolved });
    }
    return { ready: ready.sort((a, b) => byArrival(a.ticket, b.ticket)), problems };
  }

  /** Slots not held by a running headless Session, under the cap as config.yaml has it now. */
  freeSlots(): number {
    const held = this.deps.sessions.running().filter((row) => row.mode === "headless").length;
    return Math.max(0, this.reloadCap() - held);
  }

  /** Each stamped, still runnable Ticket's place in line, 1 first; computed once for a whole Ledger. */
  positions(): Map<string, number> {
    const line = this.deps.tickets
      .list()
      .filter((ticket) => ticket.runnable_since !== null)
      .filter((ticket) => {
        const resolved = this.deps.progress.runnable(ticket);
        return resolved !== null && !("problem" in resolved);
      })
      .sort(byArrival);
    return new Map(line.map((ticket, i) => [ticket.id, i + 1]));
  }

  /** Re-read `concurrency:`; a file that is missing or will not parse keeps the last cap, logged once per distinct failure. */
  private reloadCap(): number {
    const { home, log } = this.deps;
    try {
      if (!existsSync(home.configFile)) throw new Error("file is missing");
      this.cap = loadConfig(home).concurrency;
      this.lastReloadError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastReloadError) log.error("config.reload_failed", { file: home.configFile, error: message, concurrency: this.cap });
      this.lastReloadError = message;
    }
    return this.cap;
  }
}

/** Order of joining the line; the stamp is the same for Tickets one tick found together, so intake order breaks the tie. */
function byArrival(a: TicketRow, b: TicketRow): number {
  return (a.runnable_since ?? "").localeCompare(b.runnable_since ?? "") || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}
