import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { actionsFor, currentConfig, resolveProfile, type Config, type RepoConfig } from "../server/config.ts";
import type { LaissoHome } from "../server/home.ts";
import { parseName, shortId, type Tickets, type TicketRow, type NewTicket } from "../store/tickets.ts";
import type { PipelineVersions } from "../store/versions.ts";
import { checkActions, listPipelines, loadPipeline, PipelineError, type Pipeline } from "../pipeline/load.ts";
import { Git } from "../git.ts";
import { ulid } from "../ulid.ts";
import { slugify } from "./slug.ts";
import { detect, type Detection } from "./detect.ts";
import { trackerFor, TrackerError, type Issue, type Tracker } from "../tracker/tracker.ts";
import { missingFromPath, notOnPath } from "../tools/tools.ts";
import { parsePrRef, parsePrUrl, PullRequestError, type PrLookup, type PullRequests } from "../review/github.ts";
import type { GitHubRepo } from "../prs/query.ts";
import type { PrLinks } from "../store/links.ts";

export class IntakeError extends Error {}

export interface IntakeRequest {
  input: string;
  repo?: string;
  pipeline?: string;
  /** What to call the Ticket in place of its reference or short id. */
  name?: string | null;
  /** PRs to link as Referenced, in any form `laisso pr link` takes; without a repo, the first one's names it. */
  prs?: string[];
}

export interface Admitted {
  ticket: TicketRow;
  /** The branch already existed locally or on origin and was checked out rather than created. */
  branchExisted: boolean;
}

export interface IntakeDeps {
  config: Config;
  home: LaissoHome;
  tickets: Tickets;
  versions: PipelineVersions;
  links: PrLinks;
  /** gh, to confirm each PR given at Intake. */
  prs: Pick<PullRequests, "lookup">;
  /** The GitHub owner/name of a repo in config.yaml, read from its checkout's origin; null when it has none. */
  githubOf: (repo: string) => Promise<GitHubRepo | null>;
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
  async detect(input: string, repoName?: string, prs: string[] = []): Promise<Detection> {
    const { config, home } = this.deps;
    // PRs given without a repo name it: the one whose origin is the first PR's repo.
    if (prs.length && !repoName) repoName = await this.repoOfPr(prs[0]!);
    const detection = detect(config, input, listPipelines(home.pipelinesDir), repoName);
    if (repoName && prs.length) {
      detection.repo.suggestion = repoName;
      for (const pr of await this.lookupPrs(prs, repoName)) detection.notes.push(`referenced PR #${pr.number}: ${pr.title} (${pr.state.toLowerCase()})`);
    }
    if (detection.kind === "prompt") return detection;

    const reference = detection.reference!;
    this.assertNoActiveTicket(reference);

    const chosen = repoName ?? detection.repo.suggestion;
    const repo = chosen ? this.repoConfig(chosen) : null;
    if (chosen && !repo) throw new IntakeError(`repo ${chosen} is not in config.yaml`);
    if (chosen && repo) assertSameTracker(detection.kind, chosen, repo);
    const tracker = trackerFor(detection.kind, repo?.project);
    const issue = await fetchIssue(tracker, reference, chosen ?? null);
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
    const named = parseName(request.name);
    if ("problem" in named) throw new IntakeError(named.problem);
    const detection = detect(config, input, listPipelines(home.pipelinesDir), request.repo);

    const prs = request.prs ?? [];
    const repoName = request.repo ?? (prs.length ? await this.repoOfPr(prs[0]!) : detection.repo.suggestion);
    if (!repoName) throw new IntakeError("repo is ambiguous: pick one");
    const repo = this.repoConfig(repoName);
    if (!repo) throw new IntakeError(`repo ${repoName} is not in config.yaml`);
    // Every PR is confirmed before anything is made, so a typo leaves nothing behind.
    const referenced = await this.lookupPrs(prs, repoName);

    const pipelineName = request.pipeline ?? repo.pipeline;
    let pipeline: Pipeline;
    try {
      pipeline = loadPipeline(home.pipelinesDir, pipelineName);
      const now = currentConfig(home, config);
      checkActions(pipeline, actionsFor(now, repoName));
      // Every Runner Stage must reach a profile config defines for this repo, the inherited defaults included.
      for (const stage of pipeline.stages) {
        const profile = stage.kind === "runner" ? resolveProfile(now, repoName, pipeline, stage) : null;
        if (profile && "problem" in profile) throw new PipelineError(`Pipeline ${pipeline.name}: ${profile.problem}`);
      }
    } catch (error) {
      if (error instanceof PipelineError) throw new IntakeError(error.message);
      throw error;
    }

    const id = ulid();
    let row: Omit<NewTicket, "pipeline_version" | "branch" | "worktree" | "name">;
    let branch: string;
    if (detection.kind === "prompt") {
      row = { id, repo: repoName, reference: null, origin: "prompt", prompt: input, title: promptTitle(input), body: null, pipeline: pipeline.name, stage: pipeline.stages[0]!.name };
      branch = branchName(config.branch_prefix, shortId(id), slugify(input));
    } else {
      const reference = detection.reference!;
      this.assertNoActiveTicket(reference);
      assertSameTracker(detection.kind, repoName, repo);
      const tracker = trackerFor(repo.tracker, repo.project);
      const issue = await fetchIssue(tracker, reference, repoName);
      row = { id, repo: repoName, reference, origin: "tracker", prompt: null, title: issue.title, body: issue.body, pipeline: pipeline.name, stage: pipeline.stages[0]!.name };
      branch = this.referenceBranch(tracker, reference, issue.title);
    }

    const ticketDir = path.join(home.ticketsDir, id);
    const worktree = path.join(ticketDir, "worktree");
    mkdirSync(path.join(ticketDir, "sessions"), { recursive: true });

    // A new branch starts at the head of the first Referenced PR in the Ticket's own repo, so the agent sees its code.
    const github = referenced.length ? await this.deps.githubOf(repoName) : null;
    const start = github ? referenced.find((pr) => sameRepo(pr.url, github)) : undefined;

    const git = new Git(expandHome(repo.path));
    let existed: boolean;
    try {
      ({ existed } = await git.addWorktree(worktree, branch, start?.number));
    } catch (error) {
      rmSync(ticketDir, { recursive: true, force: true });
      throw error;
    }

    try {
      // Pinned last, so a refused Intake numbers no Version.
      const ticket = tickets.insert({ ...row, name: named.name, pipeline_version: this.deps.versions.pin(pipeline), branch, worktree });
      // A Referenced link is refused only on an Abandoned Ticket, which a new one is not.
      for (const pr of referenced) {
        this.deps.links.link(ticket, pr.url, "referenced", "human");
        this.deps.links.update(ticket.id, pr.url, { title: pr.title, state: pr.state, head: pr.head, base: pr.base, author: pr.author });
      }
      return { ticket, branchExisted: existed };
    } catch (error) {
      await git.removeWorktree(worktree).catch(() => undefined);
      rmSync(ticketDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** The configured repo whose GitHub origin is the PR's repo; the PR must name its repo, since no Ticket repo can yet. */
  private async repoOfPr(input: string): Promise<string> {
    const ref = parsePrRef(input, null);
    if ("problem" in ref) throw new IntakeError(`--pr ${input.trim()} needs a repo: give owner/repo#N or the URL, or pass --repo`);
    const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();
    for (const name of Object.keys(this.deps.config.repos)) {
      const github = await this.deps.githubOf(name);
      if (github && `${github.owner}/${github.name}`.toLowerCase() === wanted) return name;
    }
    throw new IntakeError(`no repo in config.yaml has its origin at github.com/${ref.owner}/${ref.repo}: pass --repo`);
  }

  /** Each PR given at Intake as GitHub has it, once each, in the order given; the bare forms are in the Ticket's repo. */
  private async lookupPrs(prs: string[], repoName: string): Promise<PrLookup[]> {
    if (!prs.length) return [];
    const home = await this.deps.githubOf(repoName);
    const found: PrLookup[] = [];
    for (const input of prs) {
      const ref = parsePrRef(input, home);
      if ("problem" in ref) throw new IntakeError(ref.problem);
      let pr: PrLookup;
      try {
        pr = await this.deps.prs.lookup(ref);
      } catch (error) {
        if (error instanceof PullRequestError) throw new IntakeError(error.message);
        throw error;
      }
      if (!found.some((f) => f.url === pr.url)) found.push(pr);
    }
    return found;
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

/** The issue from its tracker; a tracker CLI missing from PATH is named with the reference, and the repo once chosen, that needed it. */
async function fetchIssue(tracker: Tracker, reference: string, repoName: string | null): Promise<Issue> {
  try {
    return await tracker.fetchIssue(reference);
  } catch (error) {
    if (!(error instanceof TrackerError)) throw error;
    const { unstarted } = error;
    if (unstarted && missingFromPath(unstarted.tool, unstarted.errno)) throw new IntakeError(notOnPath(unstarted.tool, repoName ? `${reference} in repo ${repoName}` : reference));
    throw new IntakeError(error.message);
  }
}

/** Whether a PR's URL is in this GitHub repo. */
function sameRepo(url: string, github: GitHubRepo): boolean {
  const ref = parsePrUrl(url);
  return ref !== null && `${ref.owner}/${ref.repo}`.toLowerCase() === `${github.owner}/${github.name}`.toLowerCase();
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
