import type { RepoConfig } from "../server/config.ts";
import { expandHome } from "../intake/intake.ts";
import { runTool, type ToolResult } from "../tracker/exec.ts";
import type { GitHubRepo } from "./query.ts";

const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** The owner/name a github.com origin URL names, in SSH or HTTPS form; null for any other host. */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const m = GITHUB_REMOTE.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/**
 * The GitHub owner/name of each configured repo, by its name in config.yaml,
 * read from its checkout's `git remote get-url origin`, in config order. A
 * repo whose origin is on another host, or that has no origin to read, is
 * left out.
 */
export async function githubRepos(repos: Record<string, Pick<RepoConfig, "path">>, run: (command: string, args: string[], opts: { cwd?: string }) => Promise<ToolResult> = runTool): Promise<Record<string, GitHubRepo>> {
  const found = await Promise.all(
    Object.entries(repos).map(async ([name, repo]) => {
      if (!repo.path) return null;
      const r = await run("git", ["remote", "get-url", "origin"], { cwd: expandHome(repo.path) });
      const github = r.code === 0 ? parseGitHubRemote(r.stdout) : null;
      return github ? ([name, github] as const) : null;
    }),
  );
  return Object.fromEntries(found.filter((r) => r !== null));
}
