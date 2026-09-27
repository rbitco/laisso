import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import { Git } from "../git.ts";
import { expandHome } from "../intake/intake.ts";
import type { PullRequests } from "../review/github.ts";

export const WIP_MESSAGE = "wip: abandoned in Lasso";

export interface TeardownDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  log: Logger;
  prs: PullRequests;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A Ticket's end of life (ADR 0007): what only Lasso needed goes, what a
 * human might still want stays. Done removes the worktree and the local
 * branch, since the PR is merged. Abandon first commits and pushes whatever
 * the Runner left, keeps the branch as the salvage point, and closes an
 * open PR with a marked comment. The per-Ticket directory outlives both
 * until the retention sweep. Labels are the mirror's to clear, and the
 * tracker's status is never touched. Nothing here throws: a step that fails
 * is logged and the Ticket ends anyway.
 */
export class Teardown {
  private deps: TeardownDeps;

  constructor(deps: TeardownDeps) {
    this.deps = deps;
  }

  /** Done: the worktree goes, then the local branch; a worktree that will not go keeps its branch. */
  async done(ticket: TicketRow): Promise<void> {
    const git = this.gitFor(ticket);
    if (!git) return;
    if ((await this.step(ticket, "worktree", () => git.removeWorktree(ticket.worktree))) === null) return;
    await this.step(ticket, "branch", () => git.deleteBranch(ticket.branch));
  }

  /**
   * Abandon: WIP commit, push where the branch has a remote, close an open PR, then the worktree
   * goes and the branch stays. The PR is closed whatever became of the commit; only the worktree
   * removal depends on it, since uncommitted work is never discarded.
   */
  async abandon(ticket: TicketRow): Promise<void> {
    const git = this.gitFor(ticket);
    if (!git) return;
    const committed = await this.step(ticket, "wip", () => git.commitAll(ticket.worktree, WIP_MESSAGE));
    if (committed) this.deps.log.info("ticket.wip_committed", { ticket: ticket.id, branch: ticket.branch });
    if (committed !== null) {
      await this.step(ticket, "push", async () => {
        if (await git.remoteBranchExists(ticket.branch)) await git.push(ticket.worktree, ticket.branch);
      });
    }
    await this.step(ticket, "pr", async () => {
      const ref = await this.deps.prs.open(ticket);
      if (!ref) return;
      await this.deps.prs.close(ref, `Abandoned in Lasso. The branch \`${ticket.branch}\` is kept.\n\n<!-- lasso:${ticket.id}:abandoned -->`);
      this.deps.log.info("ticket.pr_closed", { ticket: ticket.id, pr: ref.url });
    });
    if (committed !== null) await this.step(ticket, "worktree", () => git.removeWorktree(ticket.worktree));
  }

  /**
   * The tick's sweep: a done or Abandoned Ticket's directory goes `retention` days after its end;
   * rows are never swept. A worktree still there (Abandon could not commit, or Done could not
   * remove it) goes through git first, so the repo is not left with a dangling registration; the
   * retention deadline is the one point where uncommitted work is let go, and it is logged.
   */
  async sweep(now: number = Date.now()): Promise<TickChange[]> {
    const { config, home, tickets, log } = this.deps;
    const changes: TickChange[] = [];
    for (const ticket of tickets.list({ all: true })) {
      if (ticket.state === "active") continue;
      const endedAt = Date.parse(ticket.ended_at ?? ticket.updated_at);
      if (Number.isNaN(endedAt)) {
        log.error("ticket.sweep_failed", { ticket: ticket.id, error: `unreadable end time ${ticket.ended_at ?? ticket.updated_at}` });
        continue;
      }
      if (endedAt + config.retention * DAY_MS > now) continue;
      const dir = path.join(home.ticketsDir, ticket.id);
      if (!existsSync(dir)) continue;
      if (existsSync(ticket.worktree)) {
        const git = this.gitFor(ticket);
        if (!git || (await this.step(ticket, "sweep worktree", () => git.removeWorktree(ticket.worktree))) === null) continue;
        log.info("ticket.worktree_swept", { ticket: ticket.id, state: ticket.state });
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        log.error("ticket.sweep_failed", { ticket: ticket.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      log.info("ticket.swept", { ticket: ticket.id, state: ticket.state, days: config.retention });
      changes.push({ ticket: ticket.id, summary: `directory swept, ${config.retention} days after ${ticket.state}` });
    }
    return changes;
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
