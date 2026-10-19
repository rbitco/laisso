import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions } from "../store/sessions.ts";
import { itemOf, type Feedback, type FeedbackRow } from "../store/feedback.ts";
import type { Progress } from "../session/progress.ts";
import type { Verdict } from "../session/runs.ts";
import { actionArtifact, type RunnerStage } from "../pipeline/load.ts";
import type { ActionChecks } from "../artifact/action-check.ts";
import { checkFor } from "../store/tickets.ts";
import { ownedOf, type PrLinkFacts, type PrLinks, type PrLinkRow } from "../store/links.ts";
import { parsePrUrl, type PullRequests, type PrRef } from "./github.ts";
import { addressedEvidence, checkFailed, describe, fresh, logSlice, marker, outstanding, ownMark, repeatedChecks, watermarkOf, withoutIgnored, type FeedbackItem, type IgnoredAuthor, type PrFacts, type Seen } from "./feedback.ts";

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

/** What a Round Session starts with: its number, its snapshot, and the marker its comments carry. */
export interface RoundPlan {
  round: number;
  pr: { number: number; url: string };
  items: FeedbackItem[];
  marker: string;
  /** Set when the plan came from a due snapshot rather than an earlier Session: starting it advances the watermark. */
  watermark: string | null;
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
 * has its Owned PR read, the Feedback diffed against that PR's watermark,
 * and a Round made due when something new stands. The tick then starts it like any other
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
    const owned = await this.owned(ticket);
    if (!owned) return [];
    const { ref } = owned;
    let link = owned.link;
    const changes: TickChange[] = [];
    if (owned.found) changes.push({ ticket: ticket.id, summary: `PR #${ref.number} found` });
    const own = ownMark(ticket.id, stage.name);
    const facts = await this.withoutIgnored(ticket, own, await prs.facts(ref));
    // The fetch took a while: a human may have started a Round meanwhile, which moved the watermark. Then this poll is stale.
    const now = tickets.get(ticket.id);
    const still = links.links(ticket.id).find((l) => l.url === link.url);
    if (!now || now.state !== "active" || !still || still.feedback_watermark !== link.feedback_watermark || sessions.running(ticket.id).some((s) => s.mode === "headless")) return changes;
    ticket = now;
    link = links.update(ticket.id, link.url, aboutOf(facts))!;
    const seen = seenBy(feedback.forStage(ticket.id, stage.name));
    const items = facts.state === "OPEN" ? outstanding(facts, own) : [];
    const freshItems = fresh(items, link.feedback_watermark, seen);
    const status = statusOf(facts, freshItems.length, items.length);
    if (this.record(ticket, link, status)) changes.push({ ticket: ticket.id, summary: `PR #${ref.number}: checks ${status.checks}` });
    if (facts.state === "MERGED" && !stage.artifactWith) {
      await progress.finished(ticket);
      changes.push({ ticket: ticket.id, summary: `PR #${ref.number} merged; ${stage.name} finished` });
      return changes;
    }
    if (facts.state === "CLOSED") {
      if (!ticket.flagged_at) {
        const detail = `PR #${ref.number} closed without merging`;
        await progress.flag(ticket.id, "review.pr_closed", detail);
        changes.push({ ticket: ticket.id, summary: `Flagged: ${detail}` });
      }
      return changes;
    }
    // A check Action ends the Stage, not the merge: it runs each poll while the Ticket waits, unless a human has it or one is running.
    if (stage.artifactWith) {
      if (ticket.flagged_at || this.deps.checks.running(ticket.id)) return changes;
      const verdict = await this.endCheck(ticket, stage, facts.state === "MERGED");
      const fresh = tickets.get(ticket.id);
      if (!fresh || fresh.state !== "active" || fresh.stage !== stage.name || sessions.running(ticket.id).some((s) => s.mode === "headless")) return changes;
      if (verdict === "advance") {
        await progress.finished(fresh);
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
    if (freshItems.length === 0) {
      if (link.feedback_due) links.update(ticket.id, link.url, { feedback_due: null });
      return changes;
    }
    const was = link.feedback_due ? (JSON.parse(link.feedback_due) as DueRound) : null;
    const due: DueRound = { pr: { number: ref.number, url: ref.url }, headSha: facts.headSha, items: await this.withLogs(ref, items, was), watermark: watermarkOf(facts, link.feedback_watermark) };
    links.update(ticket.id, link.url, { feedback_due: JSON.stringify(due) });
    const repeated = repeatedChecks(freshItems, seen);
    if (repeated.length && !ticket.flagged_at) {
      const detail = `check ${repeated.join(", ")} failed again after Round ${sessions.lastRound(ticket.id, stage.name)}`;
      await progress.flag(ticket.id, "review.check_repeat", detail);
      changes.push({ ticket: ticket.id, summary: `Flagged: ${detail}` });
      return changes;
    }
    const sameAsBefore = was !== null && was.items.map((i) => i.id).join() === due.items.map((i) => i.id).join();
    if (!sameAsBefore) changes.push({ ticket: ticket.id, summary: `PR #${ref.number}: ${freshItems.length} new Feedback item${freshItems.length === 1 ? "" : "s"}: ${describe(freshItems)}` });
    return changes;
  }

  /**
   * The Owned PR Review works, with its ref. A Ticket with none gets the PR on
   * its branch linked first (`found`), unless that PR was unlinked.
   */
  private async owned(ticket: TicketRow): Promise<{ link: PrLinkRow; ref: PrRef; found: boolean } | null> {
    const { links, prs } = this.deps;
    let link = ownedOf(links.links(ticket.id));
    let found = false;
    if (!link) {
      const ref = await prs.discover({ branch: ticket.branch, worktree: ticket.worktree, pr: null });
      const linked = ref ? links.autoLink(ticket, ref.url) : null;
      if (!linked || linked.role !== "owned") return null;
      link = linked;
      found = true;
    }
    const ref = parsePrUrl(link.url);
    return ref ? { link, ref, found } : null;
  }

  /**
   * What the next Session of the Stage works: the due snapshot as a new Round,
   * else the latest Round again when it did not get through (a retry re-runs
   * the same snapshot), else nothing: a repeating Stage without Feedback has
   * nothing to do, and a Round that got through is not run twice.
   */
  plan(ticket: TicketRow, stage: RunnerStage): RoundPlan | null {
    const { sessions, feedback, links } = this.deps;
    const pending = links.links(ticket.id).find((l) => l.feedback_due !== null);
    const due = pending ? (JSON.parse(pending.feedback_due!) as DueRound) : null;
    if (due) {
      const round = sessions.lastRound(ticket.id, stage.name) + 1;
      return { round, pr: due.pr, items: due.items, marker: marker(ticket.id, stage.name, round), watermark: due.watermark, fromDue: true };
    }
    const previous = sessions.latestRound(ticket.id, stage.name);
    if (!previous) return null;
    const rows = feedback.forSession(previous.id);
    const gotThrough = previous.outcome === "succeeded" && rows.every((r) => r.addressed !== null);
    if (gotThrough) return null;
    const url = ownedOf(links.links(ticket.id))?.url ?? null;
    const ref = url ? parsePrUrl(url) : null;
    const round = previous.round!;
    return { round, pr: ref ? { number: ref.number, url: ref.url } : { number: 0, url: url ?? "" }, items: rows.map(itemOf), marker: marker(ticket.id, stage.name, round), watermark: null, fromDue: false };
  }

  /** A Round Session exists: its snapshot is recorded against it, and a due Round is due no longer. */
  opened(ticket: TicketRow, sessionId: string, plan: RoundPlan): void {
    this.deps.feedback.insert(sessionId, plan.items);
    if (plan.fromDue) this.deps.links.update(ticket.id, plan.pr.url, { feedback_due: null, ...(plan.watermark ? { feedback_watermark: plan.watermark } : {}) });
  }

  /**
   * After a Round that succeeded: read the PR again, record what was
   * addressed, and say whether the Stage is done (PR merged), waits for more
   * Feedback, or Flags (spec: Addressed; review.unaddressed; review.pr_closed).
   */
  async judge(ticket: TicketRow, stage: RunnerStage, sessionId: string): Promise<Verdict> {
    const { prs, feedback, links } = this.deps;
    const owned = await this.owned(ticket);
    if (!owned) return { flag: "artifact.missing", detail: `${stage.artifact}: no PR for branch ${ticket.branch}` };
    const { link, ref } = owned;
    const own = ownMark(ticket.id, stage.name);
    const facts = await this.withoutIgnored(ticket, own, await prs.facts(ref));
    if (facts.state === "MERGED" && !stage.artifactWith) return "advance";
    if (facts.state === "MERGED") return this.endCheck(ticket, stage, true);
    const rows = feedback.forSession(sessionId);
    const evidence = new Map<number, string | null>();
    for (const row of rows) if (row.kind !== "verdict") evidence.set(row.id, addressedEvidence(itemOf(row), facts, own, false));
    const threads = rows.filter((r) => r.kind === "thread");
    const threadsAddressed = threads.length ? threads.every((r) => evidence.get(r.id) !== null) : null;
    for (const row of rows) if (row.kind === "verdict") evidence.set(row.id, addressedEvidence(itemOf(row), facts, own, threadsAddressed));
    for (const [id, why] of evidence) feedback.setAddressed(id, why);
    const left = rows.filter((r) => !evidence.get(r.id));
    const items = outstanding(facts, own);
    const known = links.update(ticket.id, link.url, aboutOf(facts)) ?? link;
    this.record(ticket, known, statusOf(facts, fresh(items, known.feedback_watermark, seenBy(feedback.forStage(ticket.id, stage.name))).length, items.length));
    if (facts.state === "CLOSED") return { flag: "review.pr_closed", detail: `PR #${ref.number} closed without merging` };
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

  /** The PR as an artifact check sees it: state and whether anyone has reviewed. */
  async probe(ticket: TicketRow): Promise<{ number: number; state: PrFacts["state"]; reviewed: boolean } | null> {
    const owned = await this.owned(ticket);
    if (!owned) return null;
    const { ref } = owned;
    const head = await this.deps.prs.head(ref);
    this.deps.links.update(ticket.id, ref.url, aboutOf(head));
    return { number: ref.number, state: head.state, reviewed: head.reviewCount > 0 || head.threads.length > 0 };
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

function seenBy(rows: Array<FeedbackRow & { round: number | null }>): Seen {
  const checks = rows.filter((r) => r.kind === "check");
  const last = Math.max(0, ...rows.map((r) => r.round ?? 0));
  return { checkIds: new Set(checks.map((r) => r.source_id)), lastRoundChecks: new Set(checks.filter((r) => r.round === last && r.name !== null).map((r) => r.name!)) };
}

export function statusOf(facts: PrFacts, freshCount: number, outstandingCount: number, now: string = new Date().toISOString()): PrStatus {
  const checks = facts.checks.length === 0 ? "none" : facts.checks.some(checkFailed) ? "failing" : facts.checks.some((c) => c.status !== "completed") ? "running" : "green";
  return { number: facts.number, url: facts.url, state: facts.state, checks, fresh: freshCount, outstanding: outstandingCount, at: now };
}

/** The why line of a quiet Ticket: what the last poll saw of its Owned PR. */
export function quietWhy(ticket: Pick<TicketRow, "artifact_checks">, links: PrLinkRow[], stage: string): string {
  const check = checkFor(ticket, stage);
  const why = prWhy(ownedOf(links), stage);
  return check?.result === "not_met" ? `${why} · ${check.action} not met` : why;
}

/** What a read of a PR saw of it, as its link keeps it; what GitHub left out keeps what the link had. */
function aboutOf(facts: Pick<PrFacts, "state" | "title" | "headRef" | "baseRef" | "author">): PrLinkFacts {
  return { state: facts.state, title: facts.title || undefined, head: facts.headRef ?? undefined, base: facts.baseRef ?? undefined, author: facts.author ?? undefined };
}

function prWhy(link: PrLinkRow | null, stage: string): string {
  const status = link?.status ? (JSON.parse(link.status) as PrStatus) : null;
  if (!status) return `${stage}: no PR yet`;
  const pr = `PR #${status.number}`;
  if (status.checks === "running") return `${pr}: checks running`;
  if (status.checks === "failing") return `${pr}: checks failing`;
  const standing = status.outstanding > 0 ? `${status.outstanding} Feedback item${status.outstanding === 1 ? "" : "s"} outstanding` : "nothing outstanding";
  return status.checks === "green" ? `${pr}: checks green, ${standing}` : `${pr}: ${standing}`;
}
