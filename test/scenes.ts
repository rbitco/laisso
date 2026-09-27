// One state of a PR as the gh shim plays it: discovery, the GraphQL query, and the three REST
// reads with ETags. Shared by the review tests and the dashboard's Metro test.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Lasso, TrackerReply } from "./harness.ts";

export const PR_URL = "https://github.com/owner/app/pull/7";

export interface Scene {
  state?: "OPEN" | "CLOSED" | "MERGED";
  head?: string;
  decision?: string | null;
  reviews?: Array<{ id: number; state: string; author: string; body: string; at: string }>;
  threads?: Array<{ id: string; resolved: boolean; path: string; line: number; comments: Array<{ id: number; author: string; body: string; at: string }> }>;
  comments?: Array<{ id: number; author: string; body: string; at: string }>;
  checks?: Array<{ id: number; name: string; status: string; conclusion: string | null; at: string }>;
  logs?: Record<number, string>;
  /** Distinguishes the ETags of one scene from another's. */
  tag: string;
}

const http = (status: number, etag: string, body?: unknown) => `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Not Modified"}\r\nEtag: ${etag}\r\nX-Ratelimit-Remaining: 4999\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`;

/** The gh replies that play one state of the PR: discovery, the GraphQL query, and the three REST reads with ETags. */
export function replies(branch: string, scene: Scene): TrackerReply[] {
  const state = scene.state ?? "OPEN";
  const head = scene.head ?? "aaaaaaa1";
  const url = (kind: string, id: number | string) => `${PR_URL}#${kind}-${id}`;
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          url: PR_URL,
          state,
          headRefOid: head,
          reviewDecision: scene.decision ?? null,
          reviewCount: { totalCount: (scene.reviews ?? []).length },
          reviews: { nodes: (scene.reviews ?? []).map((r) => ({ databaseId: r.id, state: r.state, body: r.body, submittedAt: r.at, url: url("review", r.id), author: { login: r.author } })) },
          reviewThreads: {
            nodes: (scene.threads ?? []).map((t) => ({
              id: t.id,
              isResolved: t.resolved,
              isOutdated: false,
              path: t.path,
              line: t.line,
              comments: { nodes: t.comments.map((c) => ({ databaseId: c.id, author: { login: c.author }, body: c.body, createdAt: c.at, updatedAt: c.at, url: url("discussion_r", c.id) })) },
            })),
          },
        },
      },
    },
  };
  const comments = (scene.comments ?? []).map((c) => ({ id: c.id, user: { login: c.author }, body: c.body, created_at: c.at, updated_at: c.at, html_url: url("issuecomment", c.id) }));
  const inline = (scene.threads ?? []).flatMap((t) => t.comments.map((c) => ({ id: c.id, user: { login: c.author }, body: c.body, path: t.path, line: t.line, created_at: c.at, updated_at: c.at, html_url: url("discussion_r", c.id) })));
  const checks = { check_runs: (scene.checks ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, html_url: url("check", c.id), started_at: c.at, completed_at: c.at })) };
  const rest = (match: string, etag: string, body: unknown): TrackerReply[] => [
    { tool: "gh", match: [match, `If-None-Match: ${etag}`], stdout: http(304, etag), stderr: "gh: HTTP 304", code: 1 },
    { tool: "gh", match: [match], stdout: http(200, etag, body) },
  ];
  return [
    { tool: "gh", match: ["pr view", branch], stdout: JSON.stringify({ number: 7, url: PR_URL, state }) },
    { tool: "gh", match: ["api graphql", "n=7"], stdout: JSON.stringify(graphql) },
    ...rest("issues/7/comments", `W/"${scene.tag}-comments"`, comments),
    ...rest("pulls/7/comments", `W/"${scene.tag}-inline"`, inline),
    ...rest(`commits/${head}/check-runs`, `W/"${scene.tag}-checks"`, checks),
    ...Object.entries(scene.logs ?? {}).map(([job, text]): TrackerReply => ({ tool: "gh", match: [`actions/jobs/${job}/logs`], stdout: text })),
  ];
}

export const repliesFile = (lasso: Lasso) => path.join(lasso.pathDir, "tracker-replies.json");

/** Make the shim play this scene from now on; `extra` replies (a tracker's, say) go ahead of it. */
export async function setScene(lasso: Lasso, branch: string, scene: Scene, extra: TrackerReply[] = []): Promise<void> {
  await writeFile(repliesFile(lasso), JSON.stringify([...extra, ...replies(branch, scene)]));
}

/** A scene file the fake Runner copies over the replies mid-Round: what the Runner "did" to the PR. */
export async function sceneFile(lasso: Lasso, branch: string, name: string, scene: Scene, extra: TrackerReply[] = []): Promise<string> {
  const file = path.join(lasso.pathDir, `scene-${name}.json`);
  await writeFile(file, JSON.stringify([...extra, ...replies(branch, scene)]));
  return file;
}

export const swapTo = (lasso: Lasso, file: string) => [["cp", file, repliesFile(lasso)]];

export const marker = (ticket: string, round: number) => `<!-- lasso:${ticket}:review:round-${round} -->`;
