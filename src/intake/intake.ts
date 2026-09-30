import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { actionsFor, currentConfig, type Config, type RepoConfig } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import { shortId, type Tickets, type TicketRow, type NewTicket } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import { checkActions, listPipelines, loadPipeline, PipelineError, type Pipeline } from "../pipeline/load.ts";
import { Git } from "../git.ts";
import { ulid } from "../ulid.ts";
import { slugify } from "./slug.ts";
import { detect, type Detection } from "./detect.ts";
import { trackerFor, TrackerError, type Issue, type Tracker } from "../tracker/tracker.ts";

export class IntakeError extends Error {}

export interface IntakeRequest {
  input: string;
  repo?: string;
  pipeline?: string;
}

export interface Admitted {
  ticket: TicketRow;
  /** The branch already existed locally or on origin and was checked out rather than created. */
  branchExisted: boolean;
}

export interface IntakeDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  versions: PipelineVersions;
}

/** Intake: turn a tracker reference or a prompt into a Ticket bound to a repo, a Pipeline, and a branch in its own worktree. */
export class Intake {
  private deps: IntakeDeps;

  constructor(deps: IntakeDeps) {
    this.deps = deps;
  }

  /**
   * Detection, shown before anything is confirmed. A reference is looked up on
   * its tracker so the title is known, and once the repo is settled the branch
   * is named and checked so the confirmation can say it already exists.
   */
  async detect(input: string, repoName?: string): Promise<Detection> {
    const { config, home, tickets } = this.deps;
    const detection = detect(config, input, listPipelines(home.pipelinesDir), repoName);
    if (detection.kind === "prompt") return detection;

    const reference = detection.reference!;
    this.assertNoActiveTicket(reference);

    const chosen = repoName ?? detection.repo.suggestion;
    const repo = chosen ? this.repoConfig(chosen) : null;
    if (chosen && !repo) throw new IntakeError(`repo ${chosen} is not in config.yaml`);
    if (chosen && repo) assertSameTracker(detection.kind, chosen, repo);
    const tracker = trackerFor(detection.kind, repo?.project);
    const issue = await fetchIssue(tracker, reference);
    detection.title = issue.title;

    if (repo) {
      const branch = this.referenceBranch(tracker, reference, issue.title);
      const git = new Git(expandHome(repo.path));
      await git.fetch();
      const exists = (await git.refExists(`refs/heads/${branch}`)) || (await git.refExists(`refs/remotes/origin/${branch}`));
      detection.branch = { name: branch, exists };
      if (exists) detection.notes.push(`existing branch ${branch} will be checked out`);
    }
    return detection;
  }

  /** Admit a confirmed intake: mint the Ticket, its directory, worktree, and branch. */
  async admit(request: IntakeRequest): Promise<Admitted> {
    const { config, home, tickets } = this.deps;
    const input = (request.input ?? "").trim();
    if (!input) throw new IntakeError("nothing to intake: paste a reference or type a prompt");
    const detection = detect(config, input, listPipelines(home.pipelinesDir), request.repo);

    const repoName = request.repo ?? detection.repo.suggestion;
    if (!repoName) throw new IntakeError("repo is ambiguous: pick one");
    const repo = this.repoConfig(repoName);
    if (!repo) throw new IntakeError(`repo ${repoName} is not in config.yaml`);

    const pipelineName = request.pipeline ?? repo.pipeline;
    let pipeline: Pipeline;
    try {
      pipeline = loadPipeline(home.pipelinesDir, pipelineName);
      checkActions(pipeline, actionsFor(currentConfig(home, config), repoName));
    } catch (error) {
      if (error instanceof PipelineError) throw new IntakeError(error.message);
      throw error;
    }

    const id = ulid();
    let row: Omit<NewTicket, "pipeline_version" | "branch" | "worktree">;
    let branch: string;
    if (detection.kind === "prompt") {
      row = { id, repo: repoName, reference: null, origin: "prompt", prompt: input, title: promptTitle(input), body: null, pipeline: pipeline.name, stage: pipeline.stages[0]!.name };
      branch = branchName(config.branch_prefix, shortId(id), slugify(input));
    } else {
      const reference = detection.reference!;
      this.assertNoActiveTicket(reference);
      assertSameTracker(detection.kind, repoName, repo);
      const tracker = trackerFor(repo.tracker, repo.project);
      const issue = await fetchIssue(tracker, reference);
      row = { id, repo: repoName, reference, origin: "tracker", prompt: null, title: issue.title, body: issue.body, pipeline: pipeline.name, stage: pipeline.stages[0]!.name };
      branch = this.referenceBranch(tracker, reference, issue.title);
    }

    const ticketDir = path.join(home.ticketsDir, id);
    const worktree = path.join(ticketDir, "worktree");
    mkdirSync(path.join(ticketDir, "sessions"), { recursive: true });

    const git = new Git(expandHome(repo.path));
    let existed: boolean;
    try {
      ({ existed } = await git.addWorktree(worktree, branch));
    } catch (error) {
      rmSync(ticketDir, { recursive: true, force: true });
      throw error;
    }

    try {
      // Pinned last, so a refused Intake numbers no Version.
      const ticket = tickets.insert({ ...row, pipeline_version: this.deps.versions.pin(pipeline), branch, worktree });
      return { ticket, branchExisted: existed };
    } catch (error) {
      await git.removeWorktree(worktree).catch(() => undefined);
      rmSync(ticketDir, { recursive: true, force: true });
      throw error;
    }
  }

  private repoConfig(name: string): RepoConfig | null {
    return this.deps.config.repos[name] ?? null;
  }

  /** One active Ticket per reference; a done or abandoned one may be intaken again. */
  private assertNoActiveTicket(reference: string): void {
    const active = this.deps.tickets.activeByReference(reference);
    if (active) throw new IntakeError(`${reference} already has an active Ticket (${active.id})`);
  }

  private referenceBranch(tracker: Tracker, reference: string, title: string): string {
    return branchName(this.deps.config.branch_prefix, tracker.branchKey(reference), slugify(title));
  }
}

/** A JIRA key cannot land in a GitHub-tracked repo, nor the reverse. */
function assertSameTracker(kind: Detection["kind"], repoName: string, repo: RepoConfig): void {
  if (kind !== "prompt" && kind !== repo.tracker) throw new IntakeError(`repo ${repoName} is tracked on ${repo.tracker}, not ${kind}`);
}

async function fetchIssue(tracker: Tracker, reference: string): Promise<Issue> {
  try {
    return await tracker.fetchIssue(reference);
  } catch (error) {
    if (error instanceof TrackerError) throw new IntakeError(error.message);
    throw error;
  }
}

function promptTitle(input: string): string {
  return input.length > 80 ? input.slice(0, 77).trimEnd() + "..." : input;
}

export function branchName(prefix: string, key: string, slug: string): string {
  const base = `${key}-${slug}`;
  return prefix ? `${prefix.replace(/\/+$/, "")}/${base}` : base;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}
