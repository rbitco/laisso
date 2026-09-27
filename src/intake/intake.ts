import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import { listPipelines, loadPipeline, PipelineError, type Pipeline } from "../pipeline/load.ts";
import { Git } from "../git.ts";
import { ulid } from "../ulid.ts";
import { slugify } from "./slug.ts";
import { detect, detectKind, type Detection } from "./detect.ts";

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
}

/** Intake: turn a tracker reference or a prompt into a Ticket bound to a repo, a Pipeline, and a branch in its own worktree. */
export class Intake {
  private deps: IntakeDeps;

  constructor(deps: IntakeDeps) {
    this.deps = deps;
  }

  detect(input: string, repo?: string): Detection {
    return detect(this.deps.config, input, listPipelines(this.deps.home.pipelinesDir), repo);
  }

  /** Admit a confirmed intake: mint the Ticket, its directory, worktree, and branch. */
  async admit(request: IntakeRequest): Promise<Admitted> {
    const { config, home, tickets } = this.deps;
    const input = (request.input ?? "").trim();
    if (!input) throw new IntakeError("nothing to intake: paste a reference or type a prompt");
    const { kind, reference } = detectKind(input);
    if (kind !== "prompt") throw new IntakeError(`reference intake is not available yet (${reference})`);

    const repoName = request.repo ?? this.detect(input).repo.suggestion;
    if (!repoName) throw new IntakeError("repo is ambiguous: pick one");
    const repo = config.repos[repoName];
    if (!repo) throw new IntakeError(`repo ${repoName} is not in config.yaml`);

    const pipelineName = request.pipeline ?? repo.pipeline;
    let pipeline: Pipeline;
    try {
      pipeline = loadPipeline(home.pipelinesDir, pipelineName);
    } catch (error) {
      if (error instanceof PipelineError) throw new IntakeError(error.message);
      throw error;
    }

    const id = ulid();
    const title = input.length > 80 ? input.slice(0, 77).trimEnd() + "..." : input;
    const branch = branchName(config.branch_prefix, id.slice(-8), slugify(input));
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
      const ticket = tickets.insert({
        id,
        repo: repoName,
        reference: null,
        origin: "prompt",
        prompt: input,
        title,
        body: null,
        pipeline: pipeline.name,
        stage: pipeline.stages[0]!.name,
        branch,
        worktree,
      });
      return { ticket, branchExisted: existed };
    } catch (error) {
      await git.removeWorktree(worktree).catch(() => undefined);
      rmSync(ticketDir, { recursive: true, force: true });
      throw error;
    }
  }
}

export function branchName(prefix: string, key: string, slug: string): string {
  const base = `${key}-${slug}`;
  return prefix ? `${prefix.replace(/\/+$/, "")}/${base}` : base;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}
