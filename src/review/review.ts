import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import { itemOf, type Feedback, type FeedbackRow } from "../store/feedback.ts";
import type { Progress } from "../session/progress.ts";
import type { Verdict } from "../session/runs.ts";
import { actionArtifact, type RunnerStage } from "../pipeline/load.ts";
import type { ActionChecks } from "../artifact/action-check.ts";
import type { OwnedPr } from "../artifact/check.ts";
import type { ArtifactCheck } from "../store/visits.ts";
import { ownedOf, type PrLinkFacts, type PrLinks, type PrLinkRow } from "../store/links.ts";
import { parsePrUrl, type PullRequests, type PrRef } from "./github.ts";
import { addressedEvidence, checkFailed, describe, fresh, logSlice, marker, outstanding, ownMark, repeatedChecks, watermarkOf, withoutIgnored, type FeedbackItem, type IgnoredAuthor, type PrFacts, type PrFeedback, type Seen } from "./feedback.ts";

/** The Feedback snapshot of a Round that is due: what the PR link's feedback_due holds until the Round starts. */
export interface DueRound {
  pr: { number: number; url: string };
  headSha: string;
  items: FeedbackItem[];
  watermark: string | null;
}

/** What the last poll saw of the PR, kept on its link for the displayed state. */
export interface PrStatus {
  number: number;
  url: string;
  state: PrFacts["state"];
  checks: "green" | "running" | "failing" | "none";
  /** Feedback items no Round has seen yet. */
  fresh: number;
  /** Everything standing on the PR, seen or not: a verdict awaiting re-review keeps this above zero. */
  outstanding: number;
  at: string;
}

/** What a Round Session starts with: its number, its snapshot grouped by PR, and the marker its comments carry. */
export interface RoundPlan {
  round: number;
  /** Each PR's part, in link order. `watermark` is set when the plan came from due snapshots rather than an earlier Session: starting it advances that PR's watermark. */
  prs: Array<PrFeedback & { watermark: string | null }>;
  marker: string;
  fromDue: boolean;
}

export interface ReviewDeps {
  tickets: Tickets;
  sessions: Sessions;
  feedback: Feedback;
  links: PrLinks;
  progress: Progress;
  prs: PullRequests;
  /** Runs a repeating Stage's check Action, its end condition when it has one (ADR 0014). */
  checks: ActionChecks;
  log: Logger;
  /** Whose comments are never Feedback on this Ticket's PR (review.ignore_authors, review.ignore_self); unset ignores no one. */
  ignored?: (ticket: TicketRow) => Promise<IgnoredAuthor>;
}

/**
 * The Review loop (ADR 0004): each tick, every Ticket in a repeating Stage
 * has each Owned PR not yet merged read, the Feedback diffed against that PR's own
 * watermark, and one Round made due across them when something new stands. The tick then starts it like any other
 * headless Session, so the cap and the Budget apply. After a Round, `judge`
 * reads the PR again and records what the Round addressed.
 */
export class Review {
  private deps: ReviewDeps;

  constructor(deps: ReviewDeps) {
    this.deps = deps;
  }

  /** The facts less the comments of authors this Ticket's repo ignores, so they never start a Round or hold one open. */
  private async withoutIgnored(ticket: TicketRow, own: (body: string) => boolean, facts: PrFacts): Promise<PrFacts> {
    return this.deps.ignored ? withoutIgnored(facts, own, await this.deps.ignored(ticket)) : facts;
  }

  /** The tick's poll: one line per Ticket whose PR changed something. Feedback arriving mid-Round waits. */
  async poll(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (const ticket of this.deps.tickets.list()) {
      const current = this.deps.progress.current(ticket);
      if ("problem" in current || current.stage.kind !== "runner" || !current.stage.repeat) continue;
      if (this.deps.sessions.running(ticket.id).some((s) => s.mode === "headless")) continue;
      try {
        changes.push(...(await this.pollTicket(ticket, current.stage)));
      } catch (error) {
        this.deps.log.error("review.poll_failed", { ticket: ticket.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return changes;
  }

  private async pollTicket(ticket: TicketRow, stage: RunnerStage): Promise<TickChange[]> {
    const { tickets, links, progress, prs, feedback, sessions } = this.deps;
    const changes: TickChange[] = [];
    const found = await this.branchPr(ticket);
    if (found) changes.push({ ticket: ticket.id, summary: `PR #${found.number} found` });
    if (!links.links(ticket.id).some((l) => l.role === "owned")) return changes;
    const own = ownMark(ticket.id, stage.name);
    // A merged PR is done with; a closed one is still read, so a reopen or a merge is seen.
    const read: Array<{ link: PrLinkRow; ref: PrRef; facts: PrFacts }> = [];
    for (const link of links.links(ticket.id)) {
      const ref = link.role === "owned" && link.state !== "MERGED" ? parsePrUrl(link.url) : null;
      if (ref) read.push({ link, ref, facts: await this.withoutIgnored(ticket, own, await prs.facts(ref)) });
    }
    // The fetch took a while: a human may have started a Round meanwhile, which moved a watermark. Then this poll is stale.
    const now = tickets.get(ticket.id);
    const live = links.links(ticket.id);
    const moved = read.some(({ link }) => live.find((l) => l.url === link.url)?.feedback_watermark !== link.feedback_watermark);
    if (!now || now.state !== "active" || moved || sessions.running(ticket.id).some((s) => s.mode === "headless")) return changes;
    ticket = now;
    const stageRows = feedback.forStage(ticket.id, stage.name);
    const polled = read.map(({ ref, facts, link: was }) => {
      const link = links.update(ticket.id, was.url, aboutOf(facts))!;
      const seen = seenBy(stageRows, link.url);
      const items = facts.state === "OPEN" ? outstanding(facts, own) : [];
      const freshItems = fresh(items, link.feedback_watermark, seen);
      const status = statusOf(facts, freshItems.length, items.length);
      // A merged or closed PR's checks go unread, so their going to none is no news.
      if (this.record(ticket, link, status) && facts.state === "OPEN") changes.push({ ticket: ticket.id, summary: `PR #${ref.number}: checks ${status.checks}` });
      return { link, ref, facts, seen, items, freshItems };
    });
    // Review is done when every Owned PR has merged; one merging early leaves the rest to their Rounds.
    const merged = links.links(ticket.id).filter((l) => l.role === "owned").every((l) => l.state === "MERGED");
    const mergedNow = polled.filter((p) => p.facts.state === "MERGED").map((p) => `PR #${p.ref.number}`);
    if (merged && !stage.artifactWith) {
      await progress.finished(ticket);
      changes.push({ ticket: ticket.id, summary: `${mergedNow.join(", ") || "every Owned PR"} merged; ${stage.name} finished` });
      return changes;
    }
    if (!merged) for (const pr of mergedNow) changes.push({ ticket: ticket.id, summary: `${pr} merged` });
    const closed = polled.find((p) => p.facts.state === "CLOSED");
    if (closed) {
      if (!ticket.flagged_at) {
        const detail = `PR #${closed.ref.number} closed without merging`;
        await progress.flag(ticket.id, "review.pr_closed", detail);
        changes.push({ ticket: ticket.id, summary: `Flagged: ${detail}` });
      }
      return changes;
    }
    // A check Action ends the Stage, not the merge: it runs each poll while the Ticket waits, unless a human has it or one is running.
    if (stage.artifactWith) {
      if (ticket.flagged_at || this.deps.checks.running(ticket.id)) return changes;
      const verdict = await this.endCheck(ticket, stage, merged);
      const fresh = tickets.get(ticket.id);
      if (!fresh || fresh.state !== "active" || fresh.stage !== stage.name || sessions.running(ticket.id).some((s) => s.mode === "headless")) return changes;
      if (verdict === "advance") {
        await progress.advance(fresh);
        changes.push({ ticket: ticket.id, summary: `${stage.artifact} met; ${stage.name} finished` });
        return changes;
      }
      if (verdict !== "wait") {
        await progress.flag(ticket.id, verdict.flag, verdict.detail);
        changes.push({ ticket: ticket.id, summary: `Flagged: ${verdict.detail}` });
        return changes;
      }
      ticket = fresh;
    }
    // Each PR with something new holds its own part of the one Round due; a repeated check is judged on that PR's own history.
    const repeats: string[] = [];
    const news: TickChange[] = [];
    for (const { link, ref, facts, seen, items, freshItems } of polled) {
      if (freshItems.length === 0) {
        if (link.feedback_due) links.update(ticket.id, link.url, { feedback_due: null });
        continue;
      }
      const was = link.feedback_due ? (JSON.parse(link.feedback_due) as DueRound) : null;
      const due: DueRound = { pr: { number: ref.number, url: ref.url }, headSha: facts.headSha, items: await this.withLogs(ref, items, was), watermark: watermarkOf(facts, link.feedback_watermark) };
      links.update(ticket.id, link.url, { feedback_due: JSON.stringify(due) });
      const repeated = repeatedChecks(freshItems, seen);
      if (repeated.length) repeats.push(`check ${repeated.join(", ")} failed again${polled.length > 1 ? ` on PR #${ref.number}` : ""} after Round ${seen.lastRound}`);
      const sameAsBefore = was !== null && was.items.map((i) => i.id).join() === due.items.map((i) => i.id).join();
      if (!sameAsBefore) news.push({ ticket: ticket.id, summary: `PR #${ref.number}: ${freshItems.length} new Feedback item${freshItems.length === 1 ? "" : "s"}: ${describe(freshItems)}` });
    }
    if (repeats.length && !ticket.flagged_at) {
      const detail = repeats.join("; ");
      await progress.flag(ticket.id, "review.check_repeat", detail);
      changes.push({ ticket: ticket.id, summary: `Flagged: ${detail}` });
      return changes;
    }
    changes.push(...news);
    return changes;
  }

  /**
   * The Tick's way of finding a PR: the one on the Ticket's own branch, linked
   * as Owned when it is new (and was never unlinked). Skipped while an open
   * Owned PR is on the branch. Returns the PR when this call linked it.
   */
  private async branchPr(ticket: TicketRow): Promise<PrRef | null> {
    const { links, prs } = this.deps;
    const linked = links.links(ticket.id);
    if (linked.some((l) => l.role === "owned" && (l.source === "branch" || l.head === ticket.branch) && l.state !== "MERGED" && l.state !== "CLOSED")) return null;
    const ref = await prs.discover({ branch: ticket.branch, worktree: ticket.worktree, pr: null });
    if (!ref || linked.some((l) => l.url === ref.url)) return null;
    return links.autoLink(ticket, ref.url)?.role === "owned" ? ref : null;
  }

  /**
   * What the next Session of the Stage works: the due snapshots as a new
   * Round, one part per PR, else the latest Round again when it did not get
   * through (a retry re-runs the same snapshot), else nothing: a repeating
   * Stage without Feedback has nothing to do, and a Round that got through is
   * not run twice.
   */
  plan(ticket: TicketRow, stage: RunnerStage): RoundPlan | null {
    const { sessions, feedback, links } = this.deps;
    const linked = links.links(ticket.id);
    const pending = linked.filter((l) => l.feedback_due !== null);
    if (pending.length) {
      const round = sessions.lastRound(ticket.id, stage.name) + 1;
      const prs = pending.map((link) => {
        const due = JSON.parse(link.feedback_due!) as DueRound;
        // A snapshot made before items named their PR is all on this one.
        return { pr: { ...due.pr, head: link.head, base: link.base }, items: due.items.map((i) => ({ ...i, pr: i.pr ?? link.url })), watermark: due.watermark };
      });
      return { round, prs, marker: marker(ticket.id, stage.name, round), fromDue: true };
    }
    const previous = sessions.latestRound(ticket.id, stage.name);
    if (!previous) return null;
    const rows = feedback.forSession(previous.id);
    const gotThrough = previous.outcome === "succeeded" && rows.every((r) => r.addressed !== null);
    if (gotThrough) return null;
    const fallback = ownedOf(linked)?.url ?? "";
    const groups = new Map<string, FeedbackItem[]>(rows.length ? [] : [[fallback, []]]);
    for (const row of rows) {
      const url = row.pr ?? fallback;
      groups.set(url, [...(groups.get(url) ?? []), { ...itemOf(row), pr: url }]);
    }
    const round = previous.round!;
    const prs = [...groups].map(([url, items]) => {
      const link = linked.find((l) => l.url === url);
      return { pr: { number: parsePrUrl(url)?.number ?? 0, url, head: link?.head ?? null, base: link?.base ?? null }, items, watermark: null };
    });
    return { round, prs, marker: marker(ticket.id, stage.name, round), fromDue: false };
  }

  /** A Round Session exists: its snapshot is recorded against it, and each PR's part is due no longer. */
  opened(ticket: TicketRow, sessionId: string, plan: RoundPlan): void {
    this.deps.feedback.insert(sessionId, plan.prs.flatMap((p) => p.items));
    if (!plan.fromDue) return;
    for (const { pr, watermark } of plan.prs) this.deps.links.update(ticket.id, pr.url, { feedback_due: null, ...(watermark ? { feedback_watermark: watermark } : {}) });
  }

  /**
   * After a Round that succeeded: read the PRs again, record what was
   * addressed on each, and say whether the Stage is done (every Owned PR
   * merged), waits for more Feedback, or Flags (spec: Addressed;
   * review.unaddressed; review.pr_closed).
   */
  async judge(ticket: TicketRow, stage: RunnerStage, sessionId: string): Promise<Verdict> {
    const { prs, feedback, links } = this.deps;
    await this.branchPr(ticket);
    const owned = links.links(ticket.id).filter((l) => l.role === "owned");
    if (!owned.length) return { flag: "artifact.missing", detail: `${stage.artifact}: no PR for branch ${ticket.branch}` };
    const rows = feedback.forSession(sessionId);
    const fallback = ownedOf(owned)!.url;
    const prOf = (row: FeedbackRow) => row.pr ?? fallback;
    const own = ownMark(ticket.id, stage.name);
    // Every Owned PR not yet merged is read, and every PR the Round worked on.
    const facts = new Map<string, PrFacts>();
    for (const url of new Set([...owned.filter((l) => l.state !== "MERGED").map((l) => l.url), ...rows.map(prOf)])) {
      const ref = parsePrUrl(url);
      if (ref) facts.set(url, await this.withoutIgnored(ticket, own, await prs.facts(ref)));
    }
    for (const [url, f] of facts) links.update(ticket.id, url, aboutOf(f));
    const now = links.links(ticket.id).filter((l) => l.role === "owned");
    const merged = now.length > 0 && now.every((l) => l.state === "MERGED");
    if (merged && !stage.artifactWith) return "advance";
    if (merged) return this.endCheck(ticket, stage, true);
    const evidence = new Map<number, string | null>();
    for (const url of new Set(rows.map(prOf))) {
      const f = facts.get(url);
      const mine = rows.filter((r) => prOf(r) === url);
      // An item on a PR that has merged since asks nothing more of anyone.
      if (!f || f.state === "MERGED") {
        for (const row of mine) evidence.set(row.id, f ? `PR #${f.number} merged` : null);
        continue;
      }
      for (const row of mine) if (row.kind !== "verdict") evidence.set(row.id, addressedEvidence(itemOf(row), f, own, false));
      const threads = mine.filter((r) => r.kind === "thread");
      const threadsAddressed = threads.length ? threads.every((r) => evidence.get(r.id) !== null) : null;
      for (const row of mine) if (row.kind === "verdict") evidence.set(row.id, addressedEvidence(itemOf(row), f, own, threadsAddressed));
    }
    for (const [id, why] of evidence) feedback.setAddressed(id, why);
    const left = rows.filter((r) => !evidence.get(r.id));
    const stageRows = feedback.forStage(ticket.id, stage.name);
    for (const link of now) {
      const f = facts.get(link.url);
      if (!f) continue;
      const items = outstanding(f, own);
      this.record(ticket, link, statusOf(f, fresh(items, link.feedback_watermark, seenBy(stageRows, link.url)).length, items.length));
    }
    const closed = now.find((l) => l.state === "CLOSED");
    if (closed) return { flag: "review.pr_closed", detail: `PR #${parsePrUrl(closed.url)?.number ?? 0} closed without merging` };
    if (stage.artifactWith) {
      const ended = await this.endCheck(ticket, stage, false);
      if (ended !== "wait") return ended;
    }
    if (left.length) return { flag: "review.unaddressed", detail: `${left.length} of ${rows.length} Feedback items unaddressed: ${describe(left.map(itemOf))}` };
    return "wait";
  }

  /**
   * Run a repeating Stage's check Action (ADR 0014): met ends the Stage, a
   * broken check Flags, and not met waits for Feedback while the PR is open
   * but Flags once it has merged, as no more Feedback can come.
   */
  private async endCheck(ticket: TicketRow, stage: RunnerStage, merged: boolean): Promise<Verdict> {
    const verdict = await this.deps.checks.probe(ticket, stage.name)(actionArtifact(stage.artifact!)!, stage.artifactWith ?? {});
    if (verdict.present) return "advance";
    if (verdict.broken) return { flag: "artifact.error", detail: `${stage.artifact}: ${verdict.detail}` };
    if (merged) return { flag: "artifact.missing", detail: `${stage.artifact}: ${verdict.detail} (the PR has merged)` };
    return "wait";
  }

  /** Every Owned PR as an artifact check sees it: state and whether anyone has reviewed. Referenced PRs never count. */
  async probe(ticket: TicketRow): Promise<OwnedPr[]> {
    // Finds and links the branch PR when the Ticket has no open Owned PR on it yet.
    await this.branchPr(ticket);
    const refs = this.deps.links.links(ticket.id).filter((l) => l.role === "owned").map((l) => parsePrUrl(l.url)).filter((r): r is PrRef => r !== null);
    return Promise.all(
      refs.map(async (ref) => {
        const head = await this.deps.prs.head(ref);
        this.deps.links.update(ticket.id, ref.url, aboutOf(head));
        return { number: ref.number, state: head.state, reviewed: head.reviewCount > 0 || head.threads.length > 0 };
      }),
    );
  }

  /** Failed checks get their log sliced into the snapshot once; a log already fetched for the same run is kept. */
  private async withLogs(ref: PrRef, items: FeedbackItem[], was: DueRound | null): Promise<FeedbackItem[]> {
    return Promise.all(
      items.map(async (item) => {
        if (item.kind !== "check") return item;
        const kept = was?.items.find((i) => i.kind === "check" && i.id === item.id)?.log;
        if (kept) return { ...item, log: kept };
        const text = await this.deps.prs.jobLog(ref, item.id);
        return { ...item, log: text ? logSlice(text) : null };
      }),
    );
  }

  /** Writes the PR's status on its link when it changed; true when the checks went from one state to another (a change worth a tick line). */
  private record(ticket: TicketRow, link: PrLinkRow, status: PrStatus): boolean {
    const before = link.status ? (JSON.parse(link.status) as PrStatus) : null;
    const same = before !== null && before.state === status.state && before.checks === status.checks && before.fresh === status.fresh && before.outstanding === status.outstanding && before.number === status.number;
    if (!same) {
      this.deps.links.update(ticket.id, link.url, { status: JSON.stringify(status) });
      // A changed PR is activity on the Ticket, as it was when the status lived on the Ticket.
      this.deps.tickets.update(ticket.id, {});
    }
    return before !== null && status !== null && before.number === status.number && before.checks !== status.checks;
  }
}

/** What earlier Rounds of the Stage saw of one PR, and the latest Round that worked on it; an item that names no PR counts for any. */
function seenBy(stageRows: Array<FeedbackRow & { round: number | null }>, pr: string): Seen & { lastRound: number } {
  const rows = stageRows.filter((r) => r.pr === null || r.pr === pr);
  const checks = rows.filter((r) => r.kind === "check");
  const last = Math.max(0, ...rows.map((r) => r.round ?? 0));
  return { checkIds: new Set(checks.map((r) => r.source_id)), lastRoundChecks: new Set(checks.filter((r) => r.round === last && r.name !== null).map((r) => r.name!)), lastRound: last };
}

export function statusOf(facts: PrFacts, freshCount: number, outstandingCount: number, now: string = new Date().toISOString()): PrStatus {
  const checks = facts.checks.length === 0 ? "none" : facts.checks.some(checkFailed) ? "failing" : facts.checks.some((c) => c.status !== "completed") ? "running" : "green";
  return { number: facts.number, url: facts.url, state: facts.state, checks, fresh: freshCount, outstanding: outstandingCount, at: now };
}

/** The why line of a quiet Ticket: what the last poll saw of each Owned PR not yet merged, else of the last one. */
export function quietWhy(check: ArtifactCheck | null, links: PrLinkRow[], stage: string): string {
  const owned = links.filter((l) => l.role === "owned");
  const open = owned.filter((l) => l.state !== "MERGED");
  const shown = open.length ? open : owned.slice(-1);
  const why = shown.length ? shown.map((l) => prWhy(l, stage)).join(" · ") : `${stage}: no PR yet`;
  return check?.result === "not_met" ? `${why} · ${check.action} not met` : why;
}

/** What a read of a PR saw of it, as its link keeps it; what GitHub left out keeps what the link had. */
function aboutOf(facts: Pick<PrFacts, "state" | "title" | "headRef" | "baseRef" | "author">): PrLinkFacts {
  return { state: facts.state, title: facts.title || undefined, head: facts.headRef ?? undefined, base: facts.baseRef ?? undefined, author: facts.author ?? undefined };
}

function prWhy(link: PrLinkRow, stage: string): string {
  const status = link.status ? (JSON.parse(link.status) as PrStatus) : null;
  if (!status) return `${stage}: PR #${parsePrUrl(link.url)?.number ?? 0} not read yet`;
  const pr = `PR #${status.number}`;
  if (status.checks === "running") return `${pr}: checks running`;
  if (status.checks === "failing") return `${pr}: checks failing`;
  const standing = status.outstanding > 0 ? `${status.outstanding} Feedback item${status.outstanding === 1 ? "" : "s"} outstanding` : "nothing outstanding";
  return status.checks === "green" ? `${pr}: checks green, ${standing}` : `${pr}: ${standing}`;
}
