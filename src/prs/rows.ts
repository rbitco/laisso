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
}

/** One search result node as the PR search asks for it; anything GitHub leaves out is tolerated. */
export interface PrNode {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  repository?: { nameWithOwner?: unknown } | null;
  author?: { login?: unknown } | null;
}

/** A search node as a row, or null when it is not a pull request (an empty node GitHub sends for a non-PR match). */
export function prRow(node: PrNode): PrRow | null {
  const repo = node.repository?.nameWithOwner;
  if (typeof node.number !== "number" || typeof node.url !== "string" || typeof repo !== "string") return null;
  return {
    title: typeof node.title === "string" ? node.title : "",
    repo,
    number: node.number,
    url: node.url,
    author: typeof node.author?.login === "string" ? node.author.login : "ghost",
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
  };
}
