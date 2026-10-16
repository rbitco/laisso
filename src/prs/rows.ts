import { ticketLabel, type TicketRow } from "../store/tickets.ts";
import type { GitHubRepo } from "./query.ts";

/** How a verdict pill is coloured, by the dashboard's tone tokens. */
export type VerdictTone = "crit" | "amber" | "run" | "good" | "muted";

/** What happens next on a PR, in a word or two, with the reason shown under the title. */
export interface Verdict {
  word: string;
  reason: string;
  tone: VerdictTone;
}

/** A PR's checks counted into four groups, across check runs and commit statuses; a group with no checks is left out. */
export interface CheckCounts {
  passed?: number;
  failing?: number;
  running?: number;
  skipped?: number;
}

/** Where a reviewer stands: approved, asked for changes, asked to review, needs to look again, or only commented. */
export type ReviewerState = "approved" | "changes" | "requested" | "rereview" | "commented";

/** A person (or bot), a team, or a team GitHub won't show the signed-in user. */
export type ReviewerKind = "person" | "team" | "hidden-team";

/** One reviewer on a PR: a review they left, or a request still waiting on them. */
export interface Reviewer {
  /** The person's login or the team's org/slug; null for a hidden team. */
  name: string | null;
  kind: ReviewerKind;
  state: ReviewerState;
  /** Asked for as a code owner, so they must approve before merging. */
  required: boolean;
  /** What the avatar shows without a picture: two letters of a login, a team's initials, or "?" for a hidden team. */
  initials: string;
  /** The person's GitHub picture, when GitHub gave one. */
  avatarUrl?: string;
}

/** One PR on a PR List, as the Pull Requests page shows it. */
export interface PrRow {
  title: string;
  /** owner/name */
  repo: string;
  number: number;
  url: string;
  /** The author's login; "ghost" when GitHub has none (a deleted account). */
  author: string;
  updatedAt: string;
  verdict: Verdict;
  /** Empty when the PR has no checks. */
  checks: CheckCounts;
  /** Worst state first. */
  reviewers: Reviewer[];
  /** The Lasso Ticket for this PR, or null when Lasso has none. */
  ticket: PrTicket | null;
}

/** The Lasso Ticket a PR row links to, read as the Ledger reads it. */
export interface PrTicket {
  id: string;
  /** The Ticket's label: its name, else its reference, else its short id. */
  ref: string;
  /** The current Stage's name, or "done" for a finished Ticket. */
  stage: string;
  /** Why the Ticket is Flagged, or null when it is not. */
  flag: string | null;
}

/** A Ticket as PR matching sees it: what a row shows, and the PR URL, GitHub repo and branch it can match on. */
export interface TicketForPr extends PrTicket {
  pr: string | null;
  /** The GitHub owner/name of the Ticket's repo origin; null when it is not on github.com. */
  github: GitHubRepo | null;
  branch: string;
  active: boolean;
}

/** Finds the Ticket for a PR by its URL, or by its repo and head branch; null when there is none. */
export type TicketMatch = (pr: { url: string; repo: string; branch: string | null }) => PrTicket | null;

/**
 * A Ticket as PR matching sees it, or null for an Abandoned Ticket, which never claims a PR. A done Ticket still
 * does, so a merged PR on a list of closed PRs keeps its link.
 */
export function ticketForPr(ticket: Pick<TicketRow, "id" | "name" | "reference" | "stage" | "state" | "flagged_at" | "flag_reason" | "pr" | "branch">, github: GitHubRepo | null): TicketForPr | null {
  if (ticket.state === "abandoned") return null;
  return {
    id: ticket.id,
    ref: ticketLabel(ticket),
    stage: ticket.state === "done" ? "done" : ticket.stage,
    flag: ticket.flagged_at ? ticket.flag_reason || "flagged" : null,
    pr: ticket.pr,
    github,
    branch: ticket.branch,
    active: ticket.state === "active",
  };
}

/** A PR URL compared without case or trailing slashes. */
const urlKey = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
/** A GitHub repo and branch compared without case, as GitHub compares repo names. */
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}\n${branch}`;

/**
 * Matches PRs to these Tickets: by PR URL first, then by GitHub repo and head branch. When more than one Ticket
 * matches the same way, an active one wins over a done one, then the first given.
 */
export function ticketMatcher(tickets: TicketForPr[]): TicketMatch {
  const byUrl = new Map<string, TicketForPr>();
  const byBranch = new Map<string, TicketForPr>();
  const keep = (map: Map<string, TicketForPr>, key: string, t: TicketForPr) => {
    const had = map.get(key);
    if (!had || (t.active && !had.active)) map.set(key, t);
  };
  for (const t of tickets) {
    if (t.pr) keep(byUrl, urlKey(t.pr), t);
    if (t.github && t.branch) keep(byBranch, branchKey(`${t.github.owner}/${t.github.name}`, t.branch), t);
  }
  return ({ url, repo, branch }) => {
    const t = byUrl.get(urlKey(url)) ?? (branch ? byBranch.get(branchKey(repo, branch)) : undefined);
    return t ? { id: t.id, ref: t.ref, stage: t.stage, flag: t.flag } : null;
  };
}

/** Matches nothing, for rows with no Tickets to link. */
const NO_TICKETS: TicketMatch = () => null;

/** A state and how many checks are in it, as GitHub counts them for a commit's status check rollup. */
interface StateCount {
  state?: unknown;
  count?: unknown;
}

type Review = { author?: { __typename?: unknown; login?: unknown; avatarUrl?: unknown } | null; state?: unknown; commit?: { oid?: unknown } | null } | null;

type RequestedReviewer = { __typename?: unknown; login?: unknown; avatarUrl?: unknown; name?: unknown; slug?: unknown; combinedSlug?: unknown } | null;

type Rollup = { contexts?: { checkRunCountsByState?: StateCount[] | null; statusContextCountsByState?: StateCount[] | null } | null } | null;

/** One search result node as the PR search asks for it; anything GitHub leaves out is tolerated. */
export interface PrNode {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  repository?: { nameWithOwner?: unknown } | null;
  author?: { login?: unknown } | null;
  headRefName?: unknown;
  /** OPEN, CLOSED or MERGED: a PR List's query may ask for closed ones. */
  state?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
  reviewDecision?: unknown;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: Rollup } | null } | null)[] | null } | null;
  headRefOid?: unknown;
  latestReviews?: { nodes?: Review[] | null } | null;
  latestOpinionatedReviews?: { nodes?: Review[] | null } | null;
  /** A null requestedReviewer is a team the signed-in user can't see. */
  reviewRequests?: { nodes?: ({ asCodeOwner?: unknown; requestedReviewer?: RequestedReviewer } | null)[] | null } | null;
}

/**
 * Which group each check state counts toward. Check run states mix status and conclusion; commit statuses add ERROR
 * and EXPECTED. COMPLETED should not appear once a run has a conclusion, so it counts as passed.
 */
const GROUP: Record<string, keyof CheckCounts> = {
  SUCCESS: "passed", NEUTRAL: "passed", COMPLETED: "passed",
  FAILURE: "failing", TIMED_OUT: "failing", CANCELLED: "failing", ACTION_REQUIRED: "failing", STARTUP_FAILURE: "failing", ERROR: "failing",
  QUEUED: "running", IN_PROGRESS: "running", PENDING: "running", WAITING: "running", EXPECTED: "running",
  SKIPPED: "skipped", STALE: "skipped",
};

/**
 * A search node as a row, or null when it is not a pull request (an empty node GitHub sends for a non-PR match).
 * `match` finds the PR's Ticket; a Flag on it is added to the verdict's reason.
 */
export function prRow(node: PrNode, match: TicketMatch = NO_TICKETS): PrRow | null {
  const repo = node.repository?.nameWithOwner;
  if (typeof node.number !== "number" || typeof node.url !== "string" || typeof repo !== "string") return null;
  const checks = checkCounts(node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup);
  const author = typeof node.author?.login === "string" ? node.author.login : "ghost";
  const people = reviewers(node, author);
  const ticket = match({ url: node.url, repo, branch: typeof node.headRefName === "string" ? node.headRefName : null });
  const next = verdict(node, checks, people);
  return {
    title: typeof node.title === "string" ? node.title : "",
    repo,
    number: node.number,
    url: node.url,
    author,
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    verdict: ticket?.flag ? { ...next, reason: `${next.reason} · Flagged: ${ticket.flag}` } : next,
    checks,
    reviewers: people,
    ticket,
  };
}

/** The last commit's checks, both kinds summed into their groups. GitHub lists every state, mostly with a zero count. */
function checkCounts(rollup: Rollup | undefined): CheckCounts {
  const counts: CheckCounts = {};
  const contexts = rollup?.contexts;
  for (const { state, count } of [...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])]) {
    const group = typeof state === "string" ? GROUP[state] : undefined;
    if (group && typeof count === "number" && count > 0) counts[group] = (counts[group] ?? 0) + count;
  }
  return counts;
}

/** The first rule that matches, worst first. */
function verdict(node: PrNode, checks: CheckCounts, people: Reviewer[]): Verdict {
  if (node.state === "MERGED") return { word: "Merged", reason: "merged into the base branch", tone: "muted" };
  if (node.state === "CLOSED") return { word: "Closed", reason: "closed without merging", tone: "muted" };
  if (node.isDraft === true) return { word: "Draft", reason: "not ready for review", tone: "muted" };
  if (node.mergeable === "CONFLICTING") return { word: "Conflicts", reason: "needs a rebase onto the base branch", tone: "crit" };
  if (checks.failing) return { word: "Checks failing", reason: "a required check failed", tone: "crit" };
  if (node.reviewDecision === "CHANGES_REQUESTED") return { word: "Changes requested", reason: "a reviewer asked for changes", tone: "amber" };
  if (checks.running) return { word: "Checks running", reason: "waiting on CI", tone: "run" };
  if (node.reviewDecision === "REVIEW_REQUIRED") return { word: "Needs review", reason: waitingOn(people), tone: "amber" };
  return { word: "Ready to merge", reason: readyReason(node, checks), tone: "good" };
}

/** Why nothing stands in the way, naming only what the PR has: passed checks, an approval, or neither. */
function readyReason(node: PrNode, checks: CheckCounts): string {
  const parts = [...(checks.passed ? ["checks green"] : []), ...(node.reviewDecision === "APPROVED" ? ["approved"] : [])];
  return parts.length ? parts.join(", ") : "no checks or reviews required";
}

/** Worst first: what blocks the merge, then who still has to look, then who has only commented or already approved. */
const RANK: ReviewerState[] = ["changes", "rereview", "requested", "commented", "approved"];

/**
 * Everyone asked to review or who has reviewed, merged from the three review lists, worst state first. A person needs
 * to re-review when their latest opinionated review is on an older commit, their latest review was dismissed, or they
 * were asked again after reviewing (GitHub then drops them from latestReviews but keeps them in
 * latestOpinionatedReviews). Bots never need to, and nor does someone who has only commented, as the rule hangs on an
 * opinionated review. The PR's author is left out: replying to a review leaves them a COMMENTED review of their own.
 * Teams only ever show as requested; once a member reviews, GitHub drops the team's request.
 */
function reviewers(node: PrNode, author: string): Reviewer[] {
  const head = typeof node.headRefOid === "string" ? node.headRefOid : null;
  const latest = byLogin(node.latestReviews?.nodes);
  const opinionated = byLogin(node.latestOpinionatedReviews?.nodes);
  const people = new Map<string, { required: boolean; requested: boolean; bot: boolean; avatarUrl?: string }>();
  const teams: Reviewer[] = [];
  const person = (login: string) => {
    let p = people.get(login);
    if (!p) people.set(login, (p = { required: false, requested: false, bot: false }));
    return p;
  };

  for (const request of node.reviewRequests?.nodes ?? []) {
    if (!request) continue;
    const required = request.asCodeOwner === true;
    const r = request.requestedReviewer;
    if (r === null || r === undefined) {
      teams.push({ name: null, kind: "hidden-team", state: "requested", required, initials: "?" });
    } else if (r.__typename === "Team") {
      const name = [r.combinedSlug, r.slug, r.name].find((n): n is string => typeof n === "string");
      if (name) teams.push({ name, kind: "team", state: "requested", required, initials: teamInitials(name) });
    } else if (typeof r.login === "string") {
      const p = person(r.login);
      p.requested = true;
      p.required ||= required;
      p.bot ||= r.__typename === "Bot";
      if (typeof r.avatarUrl === "string") p.avatarUrl = r.avatarUrl;
    }
  }
  for (const [login, review] of [...opinionated, ...latest]) {
    const p = person(login);
    p.bot ||= review.author?.__typename === "Bot";
    if (!p.avatarUrl && typeof review.author?.avatarUrl === "string") p.avatarUrl = review.author.avatarUrl;
  }
  people.delete(author);

  const out: Reviewer[] = [];
  for (const [login, p] of people) {
    const op = opinionated.get(login);
    const last = latest.get(login);
    const stale = head !== null && typeof op?.commit?.oid === "string" && op.commit.oid !== head;
    const rereview = !p.bot && ((op !== undefined && (stale || p.requested)) || last?.state === "DISMISSED");
    const state = rereview ? "rereview" : p.requested ? "requested" : (reviewState(op?.state) ?? reviewState(last?.state));
    if (!state) continue;
    out.push({ name: login, kind: "person", state, required: p.required, initials: login.slice(0, 2).toUpperCase(), ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) });
  }
  // A stable sort, so within a state people keep GitHub's order, ahead of teams.
  return [...out, ...teams].sort((a, b) => RANK.indexOf(a.state) - RANK.indexOf(b.state));
}

/** Each author's review, by login; a review with no author (a deleted account) is left out. */
function byLogin(nodes: Review[] | null | undefined): Map<string, NonNullable<Review>> {
  const map = new Map<string, NonNullable<Review>>();
  for (const review of nodes ?? []) if (review && typeof review.author?.login === "string") map.set(review.author.login, review);
  return map;
}

/** A review's state as a reviewer's; a bot's dismissed review counts as a comment. */
function reviewState(state: unknown): ReviewerState | null {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes";
  if (state === "COMMENTED" || state === "DISMISSED") return "commented";
  return null;
}

/** A team's initials, from the part after the slash: the first letter of each - or _ separated word, or a one-word name's first two letters. */
export function teamInitials(name: string): string {
  const words = (name.split("/").pop() ?? "").split(/[-_]/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 2);
  return initials.toUpperCase() || "?";
}

/** The reason under "Needs review": who has yet to review or review again, the first three by name. */
function waitingOn(people: Reviewer[]): string {
  const pending = people.filter((r) => r.state === "requested" || r.state === "rereview").map((r) => (r.kind === "hidden-team" ? "a team you can't see" : r.kind === "team" ? `@${r.name}` : r.name));
  if (!pending.length) return "no reviewer yet";
  const named = pending.slice(0, 3).join(", ");
  return `waiting on ${pending.length > 3 ? `${named} and ${pending.length - 3} more` : named}`;
}
