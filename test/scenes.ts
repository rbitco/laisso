// One state of a PR as the gh shim plays it: discovery, the GraphQL query, and the three REST
// reads with ETags. Shared by the review tests and the dashboard's Metro test.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Laisso, TrackerReply } from "./harness.ts";

export const PR_URL = "https://github.com/owner/app/pull/7";
export const prUrl = (number: number) => `https://github.com/owner/app/pull/${number}`;

export interface Scene {
  /** The PR's number: 7, the PR on the Ticket's branch, unless set. */
  number?: number;
  /** The head and base branch names GitHub gives; left out, GitHub says nothing of them. */
  headRef?: string;
  baseRef?: string;
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

/** The gh replies that play one state of the PR: discovery, a lookup, the GraphQL query, and the three REST reads with ETags. */
export function replies(branch: string, scene: Scene): TrackerReply[] {
  const state = scene.state ?? "OPEN";
  const head = scene.head ?? "aaaaaaa1";
  const n = scene.number ?? 7;
  const pr = prUrl(n);
  const url = (kind: string, id: number | string) => `${pr}#${kind}-${id}`;
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          number: n,
          url: pr,
          state,
          ...(scene.headRef ? { headRefName: scene.headRef } : {}),
          ...(scene.baseRef ? { baseRefName: scene.baseRef } : {}),
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
  const lookup = { number: n, url: pr, title: `PR ${n}`, state, headRefName: scene.headRef ?? null, baseRefName: scene.baseRef ?? null, author: { login: "alice" } };
  return [
    { tool: "gh", match: ["pr view", pr, "--json"], stdout: JSON.stringify(lookup) },
    { tool: "gh", match: ["pr view", branch], stdout: JSON.stringify({ number: n, url: pr, state }) },
    { tool: "gh", match: ["api graphql", `n=${n} `], stdout: JSON.stringify(graphql) },
    ...rest(`issues/${n}/comments`, `W/"${scene.tag}-comments"`, comments),
    ...rest(`pulls/${n}/comments`, `W/"${scene.tag}-inline"`, inline),
    ...rest(`commits/${head}/check-runs`, `W/"${scene.tag}-checks"`, checks),
    ...Object.entries(scene.logs ?? {}).map(([job, text]): TrackerReply => ({ tool: "gh", match: [`actions/jobs/${job}/logs`], stdout: text })),
  ];
}

export const repliesFile = (laisso: Laisso) => path.join(laisso.pathDir, "tracker-replies.json");

/** Make the shim play this scene from now on; `extra` replies (a tracker's, say) go ahead of it. */
export async function setScene(laisso: Laisso, branch: string, scene: Scene, extra: TrackerReply[] = []): Promise<void> {
  await writeFile(repliesFile(laisso), JSON.stringify([...extra, ...replies(branch, scene)]));
}

/** A scene file the fake Runner copies over the replies mid-Round: what the Runner "did" to the PR. */
export async function sceneFile(laisso: Laisso, branch: string, name: string, scene: Scene, extra: TrackerReply[] = []): Promise<string> {
  const file = path.join(laisso.pathDir, `scene-${name}.json`);
  await writeFile(file, JSON.stringify([...extra, ...replies(branch, scene)]));
  return file;
}

/** Several PRs played at once, each as [the branch discovery answers for, its scene]. */
export async function setScenes(laisso: Laisso, scenes: Array<[string, Scene]>): Promise<void> {
  await writeFile(repliesFile(laisso), JSON.stringify(scenes.flatMap(([branch, scene]) => replies(branch, scene))));
}

/** A file of several PRs' scenes the fake Runner copies over the replies mid-Round. */
export async function scenesFile(laisso: Laisso, name: string, scenes: Array<[string, Scene]>): Promise<string> {
  const file = path.join(laisso.pathDir, `scene-${name}.json`);
  await writeFile(file, JSON.stringify(scenes.flatMap(([branch, scene]) => replies(branch, scene))));
  return file;
}

export const swapTo = (laisso: Laisso, file: string) => [["cp", file, repliesFile(laisso)]];

export const marker = (ticket: string, round: number) => `<!-- laisso:${ticket}:review:round-${round} -->`;
