/**
 * Feedback as the Review loop sees it (CONTEXT.md: Feedback, Round; spec:
 * Scheduler and Review loop). Pure: what a PR's comments, threads, checks and
 * verdict say, what is new since the watermark, what a Round addressed, and
 * the marker every Runner-posted comment carries. Fetching lives next door.
 */

export type FeedbackKind = "check" | "thread" | "comment" | "verdict";

/** One thing on the PR that asks for a change, as a Round is told about it. */
export interface FeedbackItem {
  kind: FeedbackKind;
  /** The source's own id: a check run, a review thread, a comment, a review. */
  id: string;
  /** A check's name: what "the same check failing twice" compares. */
  name: string | null;
  url: string | null;
  summary: string;
  path: string | null;
  line: number | null;
  /** When the source last changed; the watermark is the newest of these. */
  at: string;
  /** The head commit a check ran on; a push past it addresses the failure. */
  head: string | null;
  body: string | null;
  /** The failed step's log, sliced, for a check. */
  log: string | null;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: PrComment[];
}

export interface PrReview {
  id: string;
  state: string;
  author: string;
  body: string;
  url: string | null;
  submittedAt: string;
}

export interface CheckRun {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  at: string;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** Everything one poll learned about the PR; comments and inline comments are those updated since the watermark. */
export interface PrFacts {
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: PrState;
  headSha: string;
  reviewDecision: string | null;
  reviewCount: number;
  reviews: PrReview[];
  threads: ReviewThread[];
  comments: PrComment[];
  inline: PrComment[];
  checks: CheckRun[];
}

/** Tells a Round's own comments from Feedback: only this Stage's Rounds are excluded (spec: markers). */
export type OwnMark = (body: string) => boolean;

export function marker(ticketId: string, stage: string, round: number): string {
  return `<!-- lasso:${ticketId}:${stage}:round-${round} -->`;
}

export function ownMark(ticketId: string, stage: string): OwnMark {
  const prefix = `<!-- lasso:${ticketId}:${stage}:`;
  return (body) => body.includes(prefix);
}

/** Whose comments are never Feedback (review.ignore_authors, review.ignore_self). */
export type IgnoredAuthor = (login: string) => boolean;

/** Ignores the logins given, whatever their case; none given ignores no one. */
export function ignoring(logins: string[]): IgnoredAuthor {
  const set = new Set(logins.map((l) => l.toLowerCase()));
  return (login) => set.has(login.toLowerCase());
}

/**
 * The facts with ignored authors' comments taken out, so they are never
 * Feedback: a top-level comment by one goes, and so does a thread whose
 * comments, Lasso's own aside, are all by them. A thread anyone else has
 * joined stays whole, so its Round still reads the ignored comments. Marked
 * comments stay whoever posted them: they pair replies with what they answer.
 * Checks and the verdict are untouched.
 */
export function withoutIgnored(facts: PrFacts, own: OwnMark, ignored: IgnoredAuthor): PrFacts {
  const asked = (c: PrComment) => !own(c.body);
  return {
    ...facts,
    threads: facts.threads.filter((t) => !t.comments.some(asked) || t.comments.some((c) => asked(c) && !ignored(c.author))),
    comments: facts.comments.filter((c) => !asked(c) || !ignored(c.author)),
  };
}

const FAILED = new Set(["failure", "timed_out", "action_required"]);

export function checkFailed(check: CheckRun): boolean {
  return check.status === "completed" && check.conclusion !== null && FAILED.has(check.conclusion);
}

/** Everything on the PR that stands unaddressed right now, checks first, then threads, comments, and the verdict. */
export function outstanding(facts: PrFacts, own: OwnMark): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const check of facts.checks) {
    if (!checkFailed(check)) continue;
    items.push({ kind: "check", id: check.id, name: check.name, url: check.url, summary: `check ${check.name} failed`, path: null, line: null, at: check.at, head: facts.headSha, body: null, log: null });
  }
  for (const thread of facts.threads) {
    if (thread.isResolved) continue;
    const asked = thread.comments.filter((c) => !own(c.body));
    if (asked.length === 0) continue;
    const first = asked[0]!;
    const last = asked[asked.length - 1]!;
    const where = thread.path ? `${thread.path}${thread.line !== null ? `:${thread.line}` : ""}` : "the diff";
    items.push({ kind: "thread", id: thread.id, name: null, url: last.url ?? first.url, summary: `thread on ${where} by ${first.author}`, path: thread.path, line: thread.line, at: last.updatedAt, head: null, body: asked.map((c) => `${c.author}: ${c.body.trim()}`).join("\n\n"), log: null });
  }
  const replies = repliesTo(facts.comments, own);
  for (const comment of facts.comments) {
    if (own(comment.body) || replies.has(comment.id)) continue;
    items.push({ kind: "comment", id: comment.id, name: null, url: comment.url, summary: `comment by ${comment.author}`, path: null, line: null, at: comment.updatedAt, head: null, body: comment.body.trim(), log: null });
  }
  if (facts.reviewDecision === "CHANGES_REQUESTED") {
    const review = [...facts.reviews].reverse().find((r) => r.state === "CHANGES_REQUESTED");
    if (review) items.push({ kind: "verdict", id: review.id, name: null, url: review.url, summary: `changes requested by ${review.author}`, path: null, line: null, at: review.submittedAt, head: null, body: review.body.trim() || null, log: null });
  }
  return items;
}

/**
 * Which of Lasso's own marked comments answers which top-level comment: in
 * time order, each marked comment answers the oldest comment before it that
 * has no answer yet. One reply answers one comment; a reply to a later
 * comment never stands in for an earlier one.
 */
export function repliesTo(comments: PrComment[], own: OwnMark): Map<string, PrComment> {
  const answered = new Map<string, PrComment>();
  const open: PrComment[] = [];
  for (const comment of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!own(comment.body)) {
      open.push(comment);
      continue;
    }
    const asked = open.shift();
    if (asked) answered.set(asked.id, comment);
  }
  return answered;
}

/** The newest timestamp this poll saw anywhere on the PR: the next Round's watermark. */
export function watermarkOf(facts: PrFacts, previous: string | null): string | null {
  const stamps = [
    ...facts.comments.map((c) => c.updatedAt),
    ...facts.inline.map((c) => c.updatedAt),
    ...facts.threads.flatMap((t) => t.comments.map((c) => c.updatedAt)),
    ...facts.reviews.map((r) => r.submittedAt),
    ...(previous ? [previous] : []),
  ].filter(Boolean);
  return stamps.length ? stamps.sort().at(-1)! : null;
}

/** What earlier Rounds of the Stage saw, for telling new Feedback from old. */
export interface Seen {
  /** Check run ids any Round has been told about. */
  checkIds: Set<string>;
  /** Names of the checks the latest Round was told had failed. */
  lastRoundChecks: Set<string>;
}

/** The items a Round has not seen: activity past the watermark, or a check run no Round was told about. */
export function fresh(items: FeedbackItem[], watermark: string | null, seen: Seen): FeedbackItem[] {
  return items.filter((item) => {
    if (item.kind === "check") return !seen.checkIds.has(item.id);
    if (item.kind === "verdict") return false;
    return watermark === null || item.at > watermark;
  });
}

/** Names of the fresh failed checks that the latest Round already failed on: the second failure in a row Flags (spec: review.check_repeat). */
export function repeatedChecks(freshItems: FeedbackItem[], seen: Seen): string[] {
  return freshItems.filter((item) => item.kind === "check" && item.name !== null && seen.lastRoundChecks.has(item.name)).map((item) => item.name!);
}

/**
 * The evidence that a Round addressed an item, judged from the PR as it stands
 * after the Round (spec: Addressed), or null while it stands. `threadsAddressed`
 * is what the verdict rule asks: a changes-requested verdict is addressed by
 * its threads, or, when the review left none, by a marked reply after it.
 * Pass null when the Round had no threads to address.
 */
export function addressedEvidence(item: FeedbackItem, facts: PrFacts, own: OwnMark, threadsAddressed: boolean | null): string | null {
  switch (item.kind) {
    case "thread": {
      const thread = facts.threads.find((t) => t.id === item.id);
      if (!thread) return "thread gone";
      if (!thread.isResolved) return null;
      const reply = [...thread.comments].reverse().find((c) => own(c.body));
      return reply ? `resolved after reply ${reply.url ?? reply.id}` : "resolved";
    }
    case "comment": {
      const reply = repliesTo(facts.comments, own).get(item.id);
      return reply ? `replied ${reply.url ?? reply.id}` : null;
    }
    case "check":
      return item.head && facts.headSha !== item.head ? `new push ${facts.headSha.slice(0, 7)}` : null;
    case "verdict":
      if (facts.reviewDecision !== "CHANGES_REQUESTED") return `review decision ${facts.reviewDecision?.toLowerCase().replace("_", " ") ?? "cleared"}`;
      if (threadsAddressed !== null) return threadsAddressed ? "its threads addressed" : null;
      const reply = facts.comments.find((c) => own(c.body) && c.createdAt > item.at);
      return reply ? `replied ${reply.url ?? reply.id}` : null;
  }
}

/** A short description of the items for a Flag or a tick line. */
export function describe(items: FeedbackItem[]): string {
  return items.map((i) => i.summary).join(", ");
}

/** The lines of a job log around its first error: the failed step's group up to a little past the error. */
export function logSlice(text: string, maxLines = 80): string {
  const lines = text.split("\n").map((line) => line.replace(/^\S+T\S+Z ?/, ""));
  const error = lines.findIndex((line) => line.includes("##[error]"));
  if (error < 0) return lines.slice(-Math.min(maxLines, 40)).join("\n").trim();
  let start = error;
  for (let i = error; i >= 0 && error - i < maxLines; i--) if (lines[i]!.includes("##[group]")) { start = i; break; }
  const end = Math.min(lines.length, error + 20);
  return lines.slice(Math.max(start, end - maxLines), end).join("\n").trim();
}

/** The Feedback section of a Round's prompt: every item with its id, kind, place and text, and the marker to post. */
export function renderFeedback(items: FeedbackItem[], pr: { number: number; url: string }, round: number, mark: string): string {
  const lines = [`Feedback on PR #${pr.number} (${pr.url}), Round ${round}: ${items.length} item${items.length === 1 ? "" : "s"}.`, ""];
  items.forEach((item, i) => {
    const where = item.path ? ` at ${item.path}${item.line !== null ? `:${item.line}` : ""}` : "";
    lines.push(`${i + 1}. [${item.kind} ${item.id}] ${item.summary}${where}${item.url ? ` ${item.url}` : ""}`);
    if (item.body) lines.push(...item.body.split("\n").map((l) => `   > ${l}`));
    if (item.log) lines.push("   log:", ...item.log.split("\n").map((l) => `   | ${l}`));
  });
  lines.push("", `Reply to each comment separately, and end every comment you post on the PR with this marker, on its own line: ${mark}`);
  return lines.join("\n");
}
