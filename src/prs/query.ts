/** A repo on github.com, as its origin names it. */
export interface GitHubRepo {
  owner: string;
  name: string;
}

/**
 * Which GitHub search a PR List runs (LASSO-161): `legacy` (GraphQL type ISSUE), where OR and parentheses are only
 * text, or `advanced` (ISSUE_ADVANCED), which reads AND, OR and parentheses. A bare OR means something different in
 * each, so legacy stays the default.
 */
export type SearchSyntax = "legacy" | "advanced";

/** What a PR List searches for: the search string sent to GitHub and the same search on github.com, or why it cannot search. */
export type PrSearch = { search: string; url: string } | { problem: string };

/** Qualifiers that already say where to look, so the configured repos are not added. */
const SCOPES = /^(repo|org|user):/i;

/** Why a list scoped to the configured repos has nothing to search, and how to fix it. */
export const NO_GITHUB_REPOS = "no repo in config.yaml has a github.com origin, so there is nothing to search. Add one under repos:, or name repo:, org: or user: in the query";

/**
 * The search a PR List's query becomes: `is:pr` first, then the query, then
 * one `repo:owner/name` per configured GitHub repo (GitHub ORs them) unless
 * the query names its own repo:, org: or user:, then `sort:updated-desc`
 * unless it names a sort:. A scoped list with no GitHub repos never searches
 * all of GitHub; it reports why instead.
 *
 * Under advanced search the query goes in parentheses and the repos in one
 * OR group, so the query's own ORs cannot reach the added terms; its sort:
 * moves to the end, outside the parentheses.
 */
export function buildSearch(query: string, repos: GitHubRepo[], syntax: SearchSyntax = "legacy"): PrSearch {
  const terms = tokens(query);
  // A term's leading parentheses are grouping under advanced search, not part of its qualifier.
  const bare = (t: string) => (syntax === "advanced" ? t.replace(/^\(+/, "").replace(/\)+$/, "") : t);
  const has = (test: (term: string) => boolean) => terms.some((t) => test(bare(t)));
  const scoped = !has((t) => SCOPES.test(t));
  if (scoped && !repos.length) return { problem: NO_GITHUB_REPOS };
  const isPr = has((t) => t.toLowerCase() === "is:pr") ? [] : ["is:pr"];
  const repoTerms = scoped ? unique(repos).map((r) => `repo:${r.owner}/${r.name}`) : [];
  const sorts = terms.filter((t) => /^sort:/i.test(t));
  const sort = sorts.length ? sorts : ["sort:updated-desc"];
  if (syntax === "legacy") {
    const parts = [...isPr, ...terms, ...repoTerms, ...(sorts.length ? [] : sort)];
    const search = parts.join(" ");
    return { search, url: searchUrl(search) };
  }
  const rest = terms.filter((t) => !/^sort:/i.test(t));
  const parts = [...isPr, ...(rest.length ? [`(${rest.join(" ")})`] : []), ...(repoTerms.length > 1 ? [`(${repoTerms.join(" OR ")})`] : repoTerms), ...sort];
  const search = parts.join(" ");
  return { search, url: searchUrl(search) };
}

/** The pull request search on github.com for a search string. */
export function searchUrl(search: string): string {
  return `https://github.com/pulls?q=${encodeURIComponent(search)}`;
}

/** Whether a query names `is:issue`, which a PR List cannot show. */
export function asksForIssues(query: string): boolean {
  return tokens(query).some((t) => t.toLowerCase() === "is:issue");
}

/** The query's terms, split on spaces outside quotes, so `label:"needs review"` stays one term and a quoted `repo:` is only text. */
function tokens(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

function unique(repos: GitHubRepo[]): GitHubRepo[] {
  const seen = new Set<string>();
  return repos.filter((r) => {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
