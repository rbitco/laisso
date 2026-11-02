import { runTool, failureReason, type ToolResult } from "../tracker/exec.ts";
import type { Logger } from "../server/log.ts";
import type { PrFacts, PrComment, ReviewThread, PrReview, CheckRun, PrState } from "./feedback.ts";
import type { GitHubRepo } from "../prs/query.ts";

export class PullRequestError extends Error {}

/** What a poll needs to know about the Ticket: its branch, where its checkout is, and the PR already found. */
export interface PrTarget {
  branch: string;
  worktree: string;
  pr: string | null;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePrUrl(url: string): PrRef | null {
  const m = PR_URL.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]), url } : null;
}

const PR_LINK = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT = /^(?:([\w.-]+)\/([\w.-]+))?#(\d+)$/;
const PR_NUMBER = /^()()(\d+)$/;

/**
 * A PR as a human gives it: a full URL (a tab or anchor of the PR included),
 * `owner/repo#N`, `#N` or `N`. The bare forms are in `home`, the Ticket's
 * GitHub repo. The ref's url is the canonical https://github.com/owner/repo/pull/N.
 */
export function parsePrRef(input: string, home: GitHubRepo | null): PrRef | { problem: string } {
  const text = input.trim();
  const m = PR_LINK.exec(text) ?? PR_SHORT.exec(text) ?? PR_NUMBER.exec(text);
  if (!m) return { problem: `${text || "nothing"} is not a PR: give its URL, owner/repo#N, #N or N` };
  const [owner, repo] = m[1] ? [m[1], m[2]!] : home ? [home.owner, home.name] : [null, null];
  if (!owner || !repo) return { problem: `${text} needs a repo: the Ticket's repo has no GitHub origin, so give owner/repo#N or the URL` };
  const number = Number(m[3]);
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/** What one lookup of a PR says: the facts a link keeps beside its URL. */
export interface PrLookup {
  /** The PR's URL as GitHub gives it, which is the one a link stores. */
  url: string;
  number: number;
  title: string;
  state: PrState;
  head: string | null;
  base: string | null;
  author: string | null;
}

const QUERY = `query($owner:String!,$name:String!,$n:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$n){
    number url state title headRefName baseRefName author{login} headRefOid reviewDecision
    reviewCount: reviews { totalCount }
    reviews(last:20){ nodes{ databaseId state body submittedAt url author{login} } }
    reviewThreads(first:100,after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id isResolved isOutdated path line
      comments(first:100){ nodes{ databaseId author{login} body createdAt updatedAt url } } } }
  } } }`;

/**
 * A Ticket's PR through the gh CLI, the way the spec's tick reads it: REST for
 * issue comments, review comments and check runs with ETags and `since`, one
 * GraphQL query for threads and the review decision. Nothing here decides
 * anything; it only fetches (ADR 0004: Laisso's poller, never a Runner).
 */
export class PullRequests {
  private log: Logger;
  /** The last body each REST read returned, one entry per PR and kind of read, for If-None-Match. */
  private cache = new Map<string, { etag: string; body: string }>();
  /** The login gh is authenticated as, read once; review.ignore_self asks for it every poll. */
  private login: string | null = null;

  constructor(log: Logger) {
    this.log = log;
  }

  /** The PR for the Ticket's branch, by URL, or null when none is open or was ever opened. */
  async discover(target: PrTarget): Promise<PrRef | null> {
    if (target.pr) return parsePrUrl(target.pr);
    const r = await runTool("gh", ["pr", "view", target.branch, "--json", "number,url,state"], { cwd: target.worktree });
    if (r.code !== 0) {
      if (!/no pull requests found/i.test(r.stderr)) this.log.info("review.discover_failed", { branch: target.branch, error: failureReason("gh", r) });
      return null;
    }
    const parsed = json<{ url?: unknown }>(r, "gh pr view");
    return typeof parsed.url === "string" ? parsePrUrl(parsed.url) : null;
  }

  /** The Ticket's PR when it is open right now, else null. */
  async open(target: PrTarget): Promise<PrRef | null> {
    const r = await runTool("gh", ["pr", "view", target.pr ?? target.branch, "--json", "number,url,state"], { cwd: target.worktree });
    if (r.code !== 0) {
      if (!/no pull requests found/i.test(r.stderr)) this.log.info("review.discover_failed", { branch: target.branch, error: failureReason("gh", r) });
      return null;
    }
    const parsed = json<{ url?: unknown; state?: unknown }>(r, "gh pr view");
    return parsed.state === "OPEN" && typeof parsed.url === "string" ? parsePrUrl(parsed.url) : null;
  }

  /** One read of a PR: that it exists, its URL as GitHub has it, and the facts a link keeps. Throws with gh's reason when it can't be read. */
  async lookup(ref: PrRef): Promise<PrLookup> {
    const r = await runTool("gh", ["pr", "view", ref.url, "--json", "number,url,title,state,headRefName,baseRefName,author"]);
    if (r.code !== 0) throw new PullRequestError(`${ref.owner}/${ref.repo}#${ref.number}: ${failureReason("gh", r)}`);
    const pr = json<Record<string, unknown>>(r, "gh pr view");
    const login = (pr.author as { login?: unknown } | null)?.login;
    return {
      url: str(pr.url, ref.url),
      number: typeof pr.number === "number" ? pr.number : ref.number,
      title: str(pr.title, ""),
      state: str(pr.state, "OPEN") as PrState,
      head: typeof pr.headRefName === "string" ? pr.headRefName : null,
      base: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
      author: typeof login === "string" ? login : null,
    };
  }

  /** Close the PR with a comment (Abandon, ADR 0007). */
  async close(ref: PrRef, comment: string): Promise<void> {
    const r = await runTool("gh", ["pr", "close", ref.url, "--comment", comment]);
    if (r.code !== 0) throw new PullRequestError(`PR #${ref.number}: ${failureReason("gh", r)}`);
  }

  /** The login gh is authenticated as. Read once and kept: a re-login under another account takes a restart. */
  async viewer(): Promise<string> {
    if (this.login) return this.login;
    const r = await runTool("gh", ["api", "user", "--jq", ".login"]);
    const login = r.stdout.trim();
    if (r.code !== 0 || !login) throw new PullRequestError(`gh api user: ${failureReason("gh", r)}`);
    this.login = login;
    return login;
  }

  /**
   * Everything one tick needs. Comments are read whole (paged, ETag-cached per
   * page) rather than since the watermark: an unanswered comment from before
   * the watermark still stands, and a reply is paired with the comment it
   * answers. A merged or closed PR skips the REST calls.
   */
  async facts(ref: PrRef): Promise<PrFacts> {
    const head = await this.head(ref);
    const base: PrFacts = { ...ref, ...head, comments: [], inline: [], checks: [] };
    if (head.state !== "OPEN") return base;
    const key = (kind: string) => `${ref.owner}/${ref.repo}#${ref.number} ${kind}`;
    const [comments, inline, checks] = await Promise.all([
      this.pages(key("comments"), `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, []),
      this.pages(key("inline"), `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, ["-f", "sort=updated", "-f", "direction=asc"]),
      this.rest(key("checks"), `repos/${ref.owner}/${ref.repo}/commits/${head.headSha}/check-runs`, ["-f", "per_page=100", "-f", "filter=latest"]),
    ]);
    return {
      ...base,
      comments: comments.map(restComment),
      inline: inline.map(restComment),
      checks: asList((checks as { check_runs?: unknown }).check_runs).map(restCheck),
    };
  }

  /** A list read a hundred at a time until a page comes back short. */
  private async pages(key: string, path: string, params: string[]): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const items = asList(await this.rest(`${key} p${page}`, path, ["-f", "per_page=100", "-f", `page=${page}`, ...params]));
      all.push(...items);
      if (items.length < 100) return all;
    }
  }

  /** The plain-text log of a failed Actions job (the check run id is the job id), or null when there is none to read. */
  async jobLog(ref: PrRef, checkRunId: string): Promise<string | null> {
    const r = await runTool("gh", ["api", `repos/${ref.owner}/${ref.repo}/actions/jobs/${checkRunId}/logs`]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  /** The GraphQL half alone: state, head, decision, reviews and every thread (paged, so a thread past the first hundred is never taken for gone). */
  async head(ref: PrRef): Promise<Pick<PrFacts, "state" | "title" | "headRef" | "baseRef" | "author" | "headSha" | "reviewDecision" | "reviewCount" | "reviews" | "threads">> {
    const first = await this.page(ref, null);
    const threads = [...first.threads];
    let page = first;
    while (page.next) {
      page = await this.page(ref, page.next);
      threads.push(...page.threads);
    }
    return { state: first.state, title: first.title, headRef: first.headRef, baseRef: first.baseRef, author: first.author, headSha: first.headSha, reviewDecision: first.reviewDecision, reviewCount: first.reviewCount, reviews: first.reviews, threads };
  }

  private async page(ref: PrRef, after: string | null): Promise<Pick<PrFacts, "state" | "title" | "headRef" | "baseRef" | "author" | "headSha" | "reviewDecision" | "reviewCount" | "reviews" | "threads"> & { next: string | null }> {
    const cursor = after ? ["-F", `after=${after}`] : [];
    const r = await runTool("gh", ["api", "graphql", "-F", `owner=${ref.owner}`, "-F", `name=${ref.repo}`, "-F", `n=${ref.number}`, ...cursor, "-f", `query=${QUERY}`]);
    if (r.code !== 0) throw new PullRequestError(`PR #${ref.number}: ${failureReason("gh", r)}`);
    const data = json<{ data?: { repository?: { pullRequest?: Record<string, unknown> } } }>(r, "gh api graphql");
    const pr = data.data?.repository?.pullRequest;
    if (!pr) throw new PullRequestError(`PR #${ref.number}: GraphQL returned no pull request`);
    const nodes = (v: unknown): Record<string, unknown>[] => (v && typeof v === "object" && Array.isArray((v as { nodes?: unknown }).nodes) ? ((v as { nodes: unknown[] }).nodes as Record<string, unknown>[]) : []);
    const info = (pr.reviewThreads as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | undefined)?.pageInfo;
    return {
      state: str(pr.state, "OPEN") as PrState,
      title: str(pr.title, ""),
      headRef: typeof pr.headRefName === "string" ? pr.headRefName : null,
      baseRef: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
      author: typeof (pr.author as { login?: unknown } | null)?.login === "string" ? (pr.author as { login: string }).login : null,
      headSha: str(pr.headRefOid, ""),
      reviewDecision: typeof pr.reviewDecision === "string" && pr.reviewDecision ? pr.reviewDecision : null,
      reviewCount: Number((pr.reviewCount as { totalCount?: unknown } | undefined)?.totalCount ?? 0),
      reviews: nodes(pr.reviews).map(gqlReview),
      threads: nodes(pr.reviewThreads).map(gqlThread),
      next: info?.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null,
    };
  }

  /** A GET with the headers shown, so a 304 hands back the cached body without re-reading anything. An ETag only matches the same query, so one entry per read is safe. */
  private async rest(key: string, path: string, params: string[]): Promise<unknown> {
    const cached = this.cache.get(key);
    const headers = cached ? ["-H", `If-None-Match: ${cached.etag}`] : [];
    const r = await runTool("gh", ["api", "-i", "-X", "GET", ...headers, path, ...params]);
    const response = splitResponse(r.stdout);
    if (!response) throw new PullRequestError(`${path}: ${failureReason("gh", r)}`);
    if (response.status === 304 && cached) return JSON.parse(cached.body);
    if (response.status < 200 || response.status >= 300) throw new PullRequestError(`${path}: HTTP ${response.status}`);
    if (response.etag) this.cache.set(key, { etag: response.etag, body: response.body });
    try {
      return JSON.parse(response.body);
    } catch {
      throw new PullRequestError(`${path}: gh returned something other than JSON`);
    }
  }
}

/** The status line, the ETag and the body of a `gh api -i` answer. */
export function splitResponse(stdout: string): { status: number; etag: string | null; body: string } | null {
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!m) return null;
  const cut = stdout.search(/\r?\n\r?\n/);
  const head = cut < 0 ? stdout : stdout.slice(0, cut);
  const body = cut < 0 ? "" : stdout.slice(cut).replace(/^\r?\n\r?\n/, "");
  const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null;
  return { status: Number(m[1]), etag, body };
}

function json<T>(r: ToolResult, what: string): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new PullRequestError(`${what} returned something other than JSON`);
  }
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function restComment(c: Record<string, unknown>): PrComment {
  const user = c.user as { login?: unknown } | undefined;
  return { id: String(c.id), author: str(user?.login, "someone"), body: str(c.body, ""), url: typeof c.html_url === "string" ? c.html_url : null, createdAt: str(c.created_at, ""), updatedAt: str(c.updated_at, str(c.created_at, "")) };
}

function restCheck(c: Record<string, unknown>): CheckRun {
  return { id: String(c.id), name: str(c.name, "check"), status: str(c.status, ""), conclusion: typeof c.conclusion === "string" ? c.conclusion : null, url: typeof c.html_url === "string" ? c.html_url : typeof c.details_url === "string" ? c.details_url : null, at: str(c.completed_at, str(c.started_at, "")) };
}

function gqlReview(r: Record<string, unknown>): PrReview {
  const author = r.author as { login?: unknown } | undefined;
  return { id: String(r.databaseId), state: str(r.state, ""), author: str(author?.login, "someone"), body: str(r.body, ""), url: typeof r.url === "string" ? r.url : null, submittedAt: str(r.submittedAt, "") };
}

function gqlThread(t: Record<string, unknown>): ReviewThread {
  const comments = ((t.comments as { nodes?: unknown } | undefined)?.nodes ?? []) as Record<string, unknown>[];
  return {
    id: String(t.id),
    isResolved: t.isResolved === true,
    isOutdated: t.isOutdated === true,
    path: typeof t.path === "string" ? t.path : null,
    line: typeof t.line === "number" ? t.line : null,
    comments: (Array.isArray(comments) ? comments : []).map((c) => {
      const author = c.author as { login?: unknown } | undefined;
      return { id: String(c.databaseId), author: str(author?.login, "someone"), body: str(c.body, ""), url: typeof c.url === "string" ? c.url : null, createdAt: str(c.createdAt, ""), updatedAt: str(c.updatedAt, str(c.createdAt, "")) };
    }),
  };
}
