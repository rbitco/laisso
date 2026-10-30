import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import { TicketWork } from "../server/ticket-work.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import { Git } from "../git.ts";
import { expandHome } from "../intake/intake.ts";
import type { PullRequests } from "../review/github.ts";
import type { PrLinks } from "../store/links.ts";

export const WIP_MESSAGE = "wip: abandoned in Lasso";

export interface TeardownDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  links: PrLinks;
  log: Logger;
  prs: PullRequests;
  /** Told when a sweep that outlasted its tick ends having swept something. */
  late?: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A Ticket's end of life (ADR 0007): what only Lasso needed goes, what a
 * human might still want stays. Done removes the worktree and the local
 * branch, since the PR is merged. Abandon first commits and pushes whatever
 * the Runner left, keeps the branch as the salvage point, and closes the
 * open Owned PRs the human chose, each with a marked comment. The per-Ticket directory outlives both
 * until the retention sweep. Labels are the mirror's to clear, and the
 * tracker's status is never touched. Nothing here throws: a step that fails
 * is logged and the Ticket ends anyway.
 */
export class Teardown {
  private deps: TeardownDeps;
  // One at a time: worktree removals in one repo contend for git's lock.
  private work: TicketWork;

  constructor(deps: TeardownDeps) {
    this.deps = deps;
    this.work = new TicketWork({ step: "sweep", limit: 1, log: deps.log, late: deps.late });
  }

  /** Resolves once every sweep under way is through, those that outlasted their tick included. */
  settle(): Promise<void> {
    return this.work.settle();
  }

  /** Done: the worktree goes, then the local branch; a worktree that will not go keeps its branch. */
  async done(ticket: TicketRow): Promise<void> {
    const git = this.gitFor(ticket);
    if (!git) return;
    if ((await this.step(ticket, "worktree", () => git.removeWorktree(ticket.worktree))) === null) return;
    await this.step(ticket, "branch", () => git.deleteBranch(ticket.branch));
  }

  /**
   * Abandon: WIP commit, push where the branch has a remote, close the chosen open Owned PRs, then the worktree
   * goes and the branch stays. `close` lists the PR URLs the human ticked; only those that are open Owned PRs of
   * the Ticket are closed, so a Referenced, merged or unticked PR is never touched. Without a list, every open
   * Owned PR is closed, and a Ticket that never linked one has the PR on its branch closed, unless a human
   * unlinked it. The PRs are closed whatever became of the commit; only the worktree removal depends on it,
   * since uncommitted work is never discarded.
   */
  async abandon(ticket: TicketRow, close?: readonly string[]): Promise<void> {
    const git = this.gitFor(ticket);
    if (!git) return;
    const committed = await this.step(ticket, "wip", () => git.commitAll(ticket.worktree, WIP_MESSAGE));
    if (committed) this.deps.log.info("ticket.wip_committed", { ticket: ticket.id, branch: ticket.branch });
    if (committed !== null) {
      await this.step(ticket, "push", async () => {
        if (await git.remoteBranchExists(ticket.branch)) await git.push(ticket.worktree, ticket.branch);
      });
    }
    const { links } = this.deps;
    const open = links.ownedOpen(ticket.id);
    for (const link of close ? open.filter((l) => close.includes(l.url)) : open) await this.closePr(ticket, link.url, link.head ?? ticket.branch);
    if (!close && !links.links(ticket.id).some((l) => l.role === "owned")) await this.closePr(ticket, null, ticket.branch);
    if (committed !== null) await this.step(ticket, "worktree", () => git.removeWorktree(ticket.worktree));
  }

  /**
   * The tick's sweep: a done or Abandoned Ticket's directory goes `retention` days after its end;
   * rows are never swept. A worktree still there (Abandon could not commit, or Done could not
   * remove it) goes through git first, so the repo is not left with a dangling registration; the
   * retention deadline is the one point where uncommitted work is let go, and it is logged.
   */
  sweep(now: number = Date.now()): Promise<TickChange[]> {
    const { config, home, tickets, log } = this.deps;
    const due = new Map<string, TicketRow>();
    for (const ticket of tickets.list({ all: true })) {
      if (ticket.state === "active") continue;
      const endedAt = Date.parse(ticket.ended_at ?? ticket.updated_at);
      if (Number.isNaN(endedAt)) {
        log.error("ticket.sweep_failed", { ticket: ticket.id, error: `unreadable end time ${ticket.ended_at ?? ticket.updated_at}` });
        continue;
      }
      if (endedAt + config.retention * DAY_MS > now) continue;
      if (!existsSync(path.join(home.ticketsDir, ticket.id))) continue;
      due.set(ticket.id, ticket);
    }
    // A git that hangs on one worktree holds up only that Ticket's sweep (LASSO-203).
    return this.work.run([...due.keys()], async (id) => {
      const ticket = due.get(id)!;
      if (existsSync(ticket.worktree)) {
        const git = this.gitFor(ticket);
        if (!git || (await this.step(ticket, "sweep worktree", () => git.removeWorktree(ticket.worktree))) === null) return [];
        log.info("ticket.worktree_swept", { ticket: ticket.id, state: ticket.state });
      }
      try {
        rmSync(path.join(home.ticketsDir, ticket.id), { recursive: true, force: true });
      } catch (error) {
        log.error("ticket.sweep_failed", { ticket: ticket.id, error: error instanceof Error ? error.message : String(error) });
        return [];
      }
      log.info("ticket.swept", { ticket: ticket.id, state: ticket.state, days: config.retention });
      return [{ ticket: ticket.id, summary: `directory swept, ${config.retention} days after ${ticket.state}` }];
    });
  }

  /**
   * Close one PR if it is open right now, with the marked comment naming its own head branch as kept (ADR 0007).
   * A null URL means the PR on the Ticket's branch, which a human's unlink keeps Lasso's hands off.
   */
  private async closePr(ticket: TicketRow, url: string | null, head: string): Promise<void> {
    await this.step(ticket, "pr", async () => {
      const ref = await this.deps.prs.open({ branch: ticket.branch, worktree: ticket.worktree, pr: url });
      if (!ref || (!url && this.deps.links.unlinked(ticket.id, ref.url))) return;
      await this.deps.prs.close(ref, `Abandoned in Lasso. The branch \`${head}\` is kept.\n\n<!-- lasso:${ticket.id}:abandoned -->`);
      this.deps.log.info("ticket.pr_closed", { ticket: ticket.id, pr: ref.url });
    });
  }

  private gitFor(ticket: TicketRow): Git | null {
    const repo = this.deps.config.repos[ticket.repo];
    if (!repo) {
      this.deps.log.error("ticket.teardown_failed", { ticket: ticket.id, step: "repo", error: `repo ${ticket.repo} is not in config.yaml` });
      return null;
    }
    return new Git(expandHome(repo.path));
  }

  /** Run one step; its result, or null when it failed (logged). */
  private async step<T>(ticket: TicketRow, name: string, act: () => Promise<T>): Promise<T | null> {
    try {
      return await act();
    } catch (error) {
      this.deps.log.error("ticket.teardown_failed", { ticket: ticket.id, step: name, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}
