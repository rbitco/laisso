import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { Sessions, SessionRow, SessionEnd, EndedReason } from "../store/sessions.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import type { Progress } from "./progress.ts";
import { adapterFor } from "../runner/adapters.ts";
import { requestFor, type RunRequest, type Outcome } from "../runner/adapter.ts";
import { checkArtifact } from "../artifact/check.ts";
import { parseDuration } from "../duration.ts";

export class RunError extends Error {}

export interface RunsDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  sessions: Sessions;
  log: Logger;
  progress: Progress;
}

type Verdict = "advance" | { flag: string; detail: string | null };

interface Live {
  child: ChildProcess;
  stage: RunnerStage;
  request: RunRequest;
  stdoutPath: string;
  fd: number;
  stderr: string;
  wallTimer: NodeJS.Timeout | null;
  killReason: EndedReason | null;
  /** Set when the process never started; the Session ends interrupted and the Flag says runner.unavailable. */
  spawnError: string | null;
  /** How the process closed: a signal death or exit 143, whoever sent it, means interrupted. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  done: Promise<SessionRow>;
  resolve: (row: SessionRow) => void;
}

const KILL_GRACE_MS = 5000;

/**
 * Headless Sessions: Lasso spawns the Runner in the Ticket's worktree, tees
 * its stdout into the Ticket directory, enforces wall time, and turns the
 * parsed Outcome plus the declared artifact into advance or Flag (ADR 0003).
 */
export class Runs {
  private deps: RunsDeps;
  private live = new Map<string, Live>();
  /** Sessions whose process has closed but whose verdict is still being reached; shutdown waits for these too. */
  private settling = new Set<Promise<void>>();

  constructor(deps: RunsDeps) {
    this.deps = deps;
  }

  /** The tick's work: start a Session for every Ticket whose current Stage runs headlessly and has none running. */
  async startRunnable(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    for (const ticket of this.deps.tickets.list()) {
      const resolved = this.deps.progress.runnable(ticket);
      if (resolved === null) continue;
      if ("problem" in resolved) {
        await this.deps.progress.flag(ticket.id, "pipeline.missing", resolved.problem);
        changes.push({ ticket: ticket.id, summary: `Flagged: ${resolved.problem}` });
        continue;
      }
      const { pipeline, stage } = resolved;
      try {
        await this.start(ticket, pipeline, stage, "auto");
        changes.push({ ticket: ticket.id, summary: `started ${stage.name}` });
      } catch (error) {
        // The Runner never started, so there is no Session to blame: runner.unavailable, not outcome.*.
        const detail = error instanceof Error ? error.message : String(error);
        await this.deps.progress.flag(ticket.id, "runner.unavailable", detail);
        changes.push({ ticket: ticket.id, summary: `Flagged: ${detail}` });
      }
    }
    return changes;
  }

  async start(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, startedBy: "auto" | "human"): Promise<SessionRow> {
    const { config, home, sessions, log } = this.deps;
    const adapter = adapterFor(stage.runner);
    const sessionId = randomUUID();
    const sessionsDir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stdoutPath = path.join(sessionsDir, `${sessionId}.stdout`);

    const wallTimeMs = parseDuration(stage.budget.wallTime ?? config.budget.wallTime);
    const spent = sessions.forTicket(ticket.id).reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
    const remainingSpendUsd = Math.max(0, (pipeline.budget.spend ?? config.budget.spend) - spent);
    const request: RunRequest = { ...requestFor(ticket, stage), mode: "headless", sessionId, limits: { wallTimeMs, remainingSpendUsd } };
    const command = adapter.command(request);

    // The stdout file is opened before the row exists, so a row never outlives a process that was never spawned.
    const fd = openSync(stdoutPath, "w");
    const row = sessions.insert({
      id: sessionId,
      ticket: ticket.id,
      stage: stage.name,
      stage_snapshot: JSON.stringify(stage),
      mode: "headless",
      started_by: startedBy,
      stdout_path: stdoutPath,
      limits_honoured: JSON.stringify(adapter.honours.filter((limit) => request.limits[limit] !== undefined)),
    });

    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      detached: true,
      stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let resolve!: (row: SessionRow) => void;
    const done = new Promise<SessionRow>((r) => (resolve = r));
    const live: Live = { child, stage, request, stdoutPath, fd, stderr: "", wallTimer: null, killReason: null, spawnError: null, exit: null, done, resolve };
    this.live.set(sessionId, live);
    if (command.stdin !== undefined) child.stdin!.end(command.stdin);

    child.stdout!.on("data", (chunk: Buffer) => writeSync(fd, chunk));
    child.stderr!.on("data", (chunk: Buffer) => (live.stderr += chunk.toString()));
    child.once("spawn", () => sessions.setPid(sessionId, child.pid ?? null));
    child.once("error", (error) => {
      log.error("session.spawn_failed", { session: sessionId, error: error.message });
      live.spawnError = `${command.argv[0]}: ${error.message}`;
      this.finish(sessionId);
    });
    child.once("close", (code, signal) => {
      log.info("session.exited", { session: sessionId, code, signal });
      live.exit = { code, signal };
      this.finish(sessionId);
    });
    live.wallTimer = setTimeout(() => void this.kill(sessionId, "wall_time"), wallTimeMs);
    live.wallTimer.unref();

    log.info("session.started", { session: sessionId, ticket: ticket.id, stage: stage.name, pid: child.pid, argv0: command.argv[0] });
    return row;
  }

  /** A human's Stop: kill the process group and record interrupted with reason stop. */
  async stop(session: SessionRow): Promise<SessionRow> {
    const live = this.live.get(session.id);
    if (!live) throw new RunError(`Session ${session.id} is not running`);
    await this.kill(session.id, "stop");
    return live.done;
  }

  /** Ctrl-C: every running Session ends as interrupted with reason shutdown; its Ticket is left as it was. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.kill(id, "shutdown").then(() => this.live.get(id)?.done)));
    await Promise.all(this.settling);
  }

  /** On startup, rows still marked running belong to a Lasso that is gone: close them as shutdown. */
  reconcile(): void {
    for (const row of this.deps.sessions.running()) {
      if (row.mode !== "headless") continue;
      // Only the process group is signalled: a lone pid may have been reused by something unrelated since.
      if (row.pid) signal(-row.pid, "SIGTERM");
      this.deps.sessions.end(row.id, { ended_by: "outcome", ended_reason: "shutdown", outcome: "interrupted", final_message: null, usage: null, cost_usd: null, transcript_path: row.transcript_path });
      this.deps.log.info("session.reconciled", { session: row.id, ticket: row.ticket });
    }
  }

  /** The captured stdout from a byte offset, for live tailing. */
  readStdout(session: SessionRow, offset: number): { text: string; offset: number; ended: boolean } {
    const ended = session.ended_at !== null;
    if (!session.stdout_path) return { text: "", offset: 0, ended };
    let fd: number;
    try {
      fd = openSync(session.stdout_path, "r");
    } catch {
      return { text: "", offset: 0, ended };
    }
    try {
      const size = statSync(session.stdout_path).size;
      const from = Math.min(Math.max(0, offset), size);
      const buffer = Buffer.alloc(size - from);
      readSync(fd, buffer, 0, buffer.length, from);
      return { text: buffer.toString(), offset: size, ended };
    } finally {
      closeSync(fd);
    }
  }

  private async kill(sessionId: string, reason: EndedReason): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live || live.killReason) return;
    const pid = live.child.pid;
    // A process already gone keeps its real Outcome; only a live one is recorded as killed.
    if (!pid || live.child.exitCode !== null || live.child.signalCode !== null) return;
    live.killReason = reason;
    signal(-pid, "SIGTERM") || signal(pid, "SIGTERM");
    const hard = setTimeout(() => signal(-pid, "SIGKILL") || signal(pid, "SIGKILL"), KILL_GRACE_MS);
    hard.unref();
    await live.done;
    clearTimeout(hard);
  }

  /** Runs once per Session, on close or spawn failure; nothing it throws can escape into the process. */
  private finish(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    if (live.wallTimer) clearTimeout(live.wallTimer);
    closeSync(live.fd);
    const work: Promise<void> = this.end(sessionId, live)
      .catch((error: unknown) => {
        this.deps.log.error("session.finish_failed", { session: sessionId, error: error instanceof Error ? error.message : String(error) });
        const row = this.deps.sessions.get(sessionId);
        if (row) live.resolve(row);
      })
      .finally(() => this.settling.delete(work));
    this.settling.add(work);
  }

  private async end(sessionId: string, live: Live): Promise<void> {
    const adapter = adapterFor(live.stage.runner);
    const stdout = live.spawnError ? "" : readFileSync(live.stdoutPath, "utf8");
    const parsed = adapter.parse(stdout, live.request);
    // A signal death, whoever sent it (exit 143 is SIGTERM under a shell), is an interruption whatever stdout says.
    const terminated = live.exit?.code === 143 || live.exit?.signal != null;
    const signalName = live.exit?.signal ?? "SIGTERM";
    const outcome: Outcome = live.killReason || live.spawnError || terminated ? { ...parsed, status: "interrupted" } : parsed;
    const stderr = live.stderr.trim() || null;
    const finalMessage = outcome.finalMessage ?? (live.killReason ? `killed: ${live.killReason.replace("_", " ")}` : (live.spawnError ?? (terminated ? `terminated by ${signalName}` : stderr)));
    const end: SessionEnd = {
      ended_by: live.killReason === "stop" || live.killReason === "abandon" ? "human" : "outcome",
      ended_reason: live.killReason,
      outcome: outcome.status,
      final_message: finalMessage,
      usage: outcome.usage ? JSON.stringify(outcome.usage) : null,
      cost_usd: outcome.costUsd,
      transcript_path: outcome.transcriptPath,
      // A Runner that names its own session (Codex) reports the id in its output; it is kept so a human can resume by hand.
      runner_session_id: adapter.sessionIds === "runner" ? outcome.sessionId : null,
    };
    // The verdict is reached before the row ends so a reader never sees a
    // Session over and its Ticket not yet advanced or Flagged.
    let verdict: Verdict | null;
    if (live.killReason === "shutdown") verdict = null;
    else if (live.spawnError) verdict = { flag: "runner.unavailable", detail: live.spawnError };
    else verdict = await this.judge(live.stage, end, live.request.cwd);
    const row = this.deps.sessions.end(sessionId, end);
    this.deps.log.info("session.ended", { session: sessionId, ticket: row.ticket, stage: row.stage, outcome: row.outcome, reason: row.ended_reason, cost: row.cost_usd });
    if (verdict) await this.apply(row.ticket, verdict);
    live.resolve(row);
  }

  /** Lasso's verdict from the Outcome and the artifact (ADR 0002): advance, or Flag with the reason. */
  private async judge(stage: RunnerStage, end: SessionEnd, cwd: string): Promise<Verdict> {
    if (end.outcome !== "succeeded") {
      return { flag: end.ended_reason === "wall_time" ? "budget.wall_time" : `outcome.${end.outcome}`, detail: end.final_message };
    }
    const artifact = await checkArtifact(stage.artifact, cwd);
    return artifact.present ? "advance" : { flag: "artifact.missing", detail: `${stage.artifact}: ${artifact.detail}` };
  }

  private async apply(ticketId: string, verdict: Verdict): Promise<void> {
    const ticket = this.deps.tickets.get(ticketId);
    if (!ticket || ticket.state !== "active") return;
    if (verdict === "advance") await this.deps.progress.finished(ticket);
    else await this.deps.progress.flag(ticket.id, verdict.flag, verdict.detail);
  }
}

/** Send a signal to a pid (negative for its process group); false when there is nothing there. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}
