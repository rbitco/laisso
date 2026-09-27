import type { RepoConfig } from "../server/config.ts";
import { JiraTracker } from "./jira.ts";
import { GithubTracker } from "./github.ts";

export class TrackerError extends Error {}

export interface Issue {
  reference: string;
  title: string;
  body: string | null;
}

/** What Lasso asks of a tracker at intake; the adapters are thin translators over gh and acli. */
export interface Tracker {
  /** The JIRA project key or the GitHub owner/repo; empty when the tracker was chosen from a reference alone. */
  project: string;
  /** The part of a branch name that names the issue: the JIRA key as-is, owner-repo-n for GitHub. */
  branchKey(reference: string): string;
  fetchIssue(reference: string): Promise<Issue>;
  /** Null when `status` is a status this tracker can move an issue to; otherwise the reason it is not. */
  checkStatus(status: string): Promise<string | null>;
}

export type TrackerKind = RepoConfig["tracker"];

/**
 * The adapter for a tracker kind. Without a project (a reference detected
 * before its repo is chosen) the tracker can still fetch an issue, since the
 * reference itself names the project, but not check a status.
 */
export function trackerFor(kind: TrackerKind, project = ""): Tracker {
  return kind === "github" ? new GithubTracker(project) : new JiraTracker(project);
}
