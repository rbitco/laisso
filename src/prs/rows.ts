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
}

/** A state and how many checks are in it, as GitHub counts them for a commit's status check rollup. */
interface StateCount {
  state?: unknown;
  count?: unknown;
}

type Rollup = { contexts?: { checkRunCountsByState?: StateCount[] | null; statusContextCountsByState?: StateCount[] | null } | null } | null;

/** One search result node as the PR search asks for it; anything GitHub leaves out is tolerated. */
export interface PrNode {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  repository?: { nameWithOwner?: unknown } | null;
  author?: { login?: unknown } | null;
  isDraft?: unknown;
  mergeable?: unknown;
  reviewDecision?: unknown;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: Rollup } | null } | null)[] | null } | null;
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

/** A search node as a row, or null when it is not a pull request (an empty node GitHub sends for a non-PR match). */
export function prRow(node: PrNode): PrRow | null {
  const repo = node.repository?.nameWithOwner;
  if (typeof node.number !== "number" || typeof node.url !== "string" || typeof repo !== "string") return null;
  const checks = checkCounts(node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup);
  return {
    title: typeof node.title === "string" ? node.title : "",
    repo,
    number: node.number,
    url: node.url,
    author: typeof node.author?.login === "string" ? node.author.login : "ghost",
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    verdict: verdict(node, checks),
    checks,
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

/** The first rule that matches, worst first. Naming the reviewers a PR waits on is LASSO-133. */
function verdict(node: PrNode, checks: CheckCounts): Verdict {
  if (node.isDraft === true) return { word: "Draft", reason: "not ready for review", tone: "muted" };
  if (node.mergeable === "CONFLICTING") return { word: "Conflicts", reason: "needs a rebase onto the base branch", tone: "crit" };
  if (checks.failing) return { word: "Checks failing", reason: "a required check failed", tone: "crit" };
  if (node.reviewDecision === "CHANGES_REQUESTED") return { word: "Changes requested", reason: "a reviewer asked for changes", tone: "amber" };
  if (checks.running) return { word: "Checks running", reason: "waiting on CI", tone: "run" };
  if (node.reviewDecision === "REVIEW_REQUIRED") return { word: "Needs review", reason: "no reviewer yet", tone: "amber" };
  return { word: "Ready to merge", reason: "checks green, approved", tone: "good" };
}
