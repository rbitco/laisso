import { failureReason, runTool, type ToolResult } from "../tracker/exec.ts";
import type { PrNode } from "./rows.ts";

/**
 * One page of a PR search: search(type: ISSUE) with the fields a row uses,
 * plus issueCount and rateLimit. contexts(first:0) asks for the check counts
 * by state and no checks, which keeps a page at its usual cost. Never
 * mergeStateStatus: it is what makes GitHub time out a page
 * (docs/research/pr-check-counts.md). The three review lists are what the row
 * mapper merges into reviewers; first:20 has been enough on every PR seen.
 */
const QUERY = `query($q:String!,$n:Int!){
  rateLimit{ cost remaining resetAt }
  search(query:$q, type:ISSUE, first:$n){
    issueCount
    nodes{ ... on PullRequest{
      number title url updatedAt
      repository{ nameWithOwner }
      author{ login }
      isDraft mergeable reviewDecision headRefOid
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state
        contexts(first:0){
          checkRunCountsByState{ state count }
          statusContextCountsByState{ state count } } } } } }
      latestReviews(first:20){ nodes{ author{ __typename login avatarUrl } state commit{ oid } } }
      latestOpinionatedReviews(first:20){ nodes{ author{ login avatarUrl } state commit{ oid } } }
      reviewRequests(first:20){ nodes{ asCodeOwner requestedReviewer{ __typename
        ... on User{ login avatarUrl } ... on Team{ name slug combinedSlug } ... on Bot{ login } } } }
    } }
  }
}`;

/** How many GitHub points are left and when they reset, as the search reported. */
export interface RateLimit {
  remaining: number;
  resetAt: string;
}

/** Why a search found nothing to show: gh is not installed or not logged in, GitHub refused the query or is rate limiting, or the call failed. */
export type SearchProblem = "gh-missing" | "not-logged-in" | "rejected" | "rate-limited" | "failed";

export type SearchResult = { ok: true; total: number; nodes: PrNode[]; rateLimit: RateLimit | null } | { ok: false; problem: SearchProblem; message: string };

/** Runs one PR search of at most `limit` results. */
export type PrSearchClient = (search: string, limit: number) => Promise<SearchResult>;

type Run = (command: string, args: string[]) => Promise<ToolResult>;

/** The PR search through `gh api graphql`, every outcome sorted into a SearchResult; it never throws. */
export function ghSearch(run: Run = runTool): PrSearchClient {
  return async (search, limit) => {
    const r = await run("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${search}`, "-F", `n=${limit}`]);
    if (r.errno === "ENOENT") return { ok: false, problem: "gh-missing", message: "gh is not installed" };
    const body = parse(r.stdout);
    const errors = Array.isArray(body?.errors) ? (body.errors as { type?: unknown; message?: unknown }[]) : [];
    if (errors.some((e) => e.type === "RATE_LIMITED") || (r.code !== 0 && /rate limit/i.test(r.stderr))) return { ok: false, problem: "rate-limited", message: "GitHub rate limit" };
    if (r.code !== 0 && /gh auth login|not logged in/i.test(r.stderr)) return { ok: false, problem: "not-logged-in", message: "gh is not logged in" };
    if (errors.length) return { ok: false, problem: "rejected", message: errors.map((e) => (typeof e.message === "string" ? e.message : "GitHub refused the query")).join("; ") };
    const data = body?.data as { search?: { issueCount?: unknown; nodes?: unknown }; rateLimit?: { remaining?: unknown; resetAt?: unknown } } | undefined;
    if (r.code !== 0 || !data?.search) return { ok: false, problem: "failed", message: r.code !== 0 ? failureReason("gh", r) : "gh returned no search results" };
    const rate = data.rateLimit;
    return {
      ok: true,
      total: typeof data.search.issueCount === "number" ? data.search.issueCount : 0,
      nodes: Array.isArray(data.search.nodes) ? (data.search.nodes as PrNode[]) : [],
      rateLimit: rate && typeof rate.remaining === "number" && typeof rate.resetAt === "string" ? { remaining: rate.remaining, resetAt: rate.resetAt } : null,
    };
  };
}

function parse(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
