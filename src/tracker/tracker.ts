import type { RepoConfig } from "../server/config.ts";
import { JiraTracker } from "./jira.ts";
import { GithubTracker } from "./github.ts";
import { failureReason, type ToolResult } from "./exec.ts";

export class TrackerError extends Error {
  /** The CLI and its errno when it never ran, so a caller can tell a missing tool from a refusal. */
  readonly unstarted: { tool: string; errno: string } | null;

  constructor(message: string, unstarted: { tool: string; errno: string } | null = null) {
    super(message);
    this.unstarted = unstarted;
  }
}

/** A tracker CLI's failure on a reference, in its own words, remembering when it never ran. */
export function trackerFailure(tool: string, reference: string, r: ToolResult): TrackerError {
  return new TrackerError(`${reference}: ${failureReason(tool, r)}`, r.errno ? { tool, errno: r.errno } : null);
}

export interface Issue {
  reference: string;
  title: string;
  body: string | null;
}

/** What Lasso asks of a tracker: reading an issue at intake and mirroring labels; moving it is a config Action's (ADR 0010). The adapters are thin translators over gh and acli. */
export interface Tracker {
  /** The JIRA project key or the GitHub owner/repo; empty when the tracker was chosen from a reference alone. */
  project: string;
  /** The part of a branch name that names the issue: the JIRA key as-is, owner-repo-n for GitHub. */
  branchKey(reference: string): string;
  fetchIssue(reference: string): Promise<Issue>;
  /** The issue's labels as the tracker has them now. */
  labels(reference: string): Promise<string[]>;
  /** Add and remove labels in one write; the tracker creates unknown labels where it must. */
  editLabels(reference: string, change: LabelChange): Promise<void>;
}

export interface LabelChange {
  add: string[];
  remove: string[];
}

/** Lasso's labels on a tracker issue: `lasso:<stage>` for the current Stage, `lasso:flagged` while Flagged (ADR 0005). */
export const LABEL_PREFIX = "lasso:";
export const FLAGGED_LABEL = `${LABEL_PREFIX}flagged`;
export const mirrorLabel = (stage: string): string => `${LABEL_PREFIX}${stage}`;

export type TrackerKind = RepoConfig["tracker"];

/**
 * The adapter for a tracker kind. Without a project (a reference detected
 * before its repo is chosen) the tracker can still fetch an issue, since the
 * reference itself names the project, but not check a status.
 */
export function trackerFor(kind: TrackerKind, project = ""): Tracker {
  return kind === "github" ? new GithubTracker(project) : new JiraTracker(project);
}
