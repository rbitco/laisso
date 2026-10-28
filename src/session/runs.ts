import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { currentConfig, type Config, type ResolvedProfile } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { TickChange } from "../server/tick.ts";
import type { Tickets, TicketRow } from "../store/tickets.ts";
import type { PrLinks } from "../store/links.ts";
import type { Visits } from "../store/visits.ts";
import { sessionProfile, type Sessions, type SessionRow, type SessionEnd, type EndedReason } from "../store/sessions.ts";
import type { Pipeline, RunnerStage } from "../pipeline/load.ts";
import type { Progress } from "./progress.ts";
import { adapterFor } from "../runner/adapters.ts";
import { requestFor, type RunRequest, type Outcome } from "../runner/adapter.ts";
import { LatestMessageTracker } from "./latest-message.ts";
import { checkArtifact } from "../artifact/check.ts";
import type { ActionChecks } from "../artifact/action-check.ts";
import { parseDuration } from "../duration.ts";
import type { Budgets } from "../budget/budgets.ts";
import type { Queue } from "./queue.ts";
import { spendOf } from "../budget/budget.ts";
import type { Review, RoundPlan } from "../review/review.ts";
import { resumeRefusal, ticketProfile } from "./overrides.ts";
import { missingFromPath, notOnPath } from "../tools/tools.ts";

export class RunError extends Error {}

export interface RunsDeps {
  config: Config;
  home: LassoHome;
  tickets: Tickets;
  /** The Ticket's linked PRs, which every Session's prompt lists. */
  links: PrLinks;
  sessions: Sessions;
  /** The current Visit, whose Route text and note every Session of it is told. */
  visits: Visits;
  log: Logger;
  progress: Progress;
  budgets: Budgets;
  queue: Queue;
  review: Review;
  /** Runs a check Action artifact once a Runner has succeeded (ADR 0014). */
  checks: ActionChecks;
  /** Hears each stdout chunk once it is on disk, so a watching dashboard can read it. */
  stdoutWritten?: (ticket: string, session: string) => void;
  /** Hears a Session end outside shutdown, once its Ticket has advanced or Flagged, so the next Stage need not wait for the timer. */
  ended?: () => void;
}

/** Lasso's verdict on an ended Session: the Stage is done, waits for more Feedback (a Round), or Flags; `retry: false` Flags even with attempts left. */
export type Verdict = "advance" | "wait" | { flag: string; detail: string | null; retry?: false };

interface Live {
  child: ChildProcess;
  ticket: string;
  stage: RunnerStage;
  request: RunRequest;
  stdoutPath: string;
  fd: number;
  stderr: string;
  /** Keeps the Session's Latest Message as stdout streams. */
  messages: LatestMessageTracker;
  wallTimer: NodeJS.Timeout | null;
  killReason: EndedReason | null;
  /** A human is taking the Session over in a terminal: however it ends, Lasso reaches no verdict on it. */
  takenOver: boolean;
  /** Set when the process never started; the Session ends interrupted and the Flag says runner.unavailable. */
  spawnError: string | null;
  /** The Runner's command is not on PATH: another attempt cannot help, so the Flag comes at once. */
  notOnPath: boolean;
  /** How the process closed: a signal death or exit 143, whoever sent it, means interrupted. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  done: Promise<SessionRow>;
  resolve: (row: SessionRow) => void;
}

const KILL_GRACE_MS = 5000;

/**
 * Headless Sessions: Lasso spawns the Runner in the Ticket's worktree, tees
 * its stdout into the Ticket directory, enforces wall time, and turns the
 * parsed Outcome plus the declared artifact into advance, another attempt,
 * or Flag (ADR 0003). The Budget is checked before every start; interrupted
 * and exhausted runs try again while attempts remain (spec: Budget).
 */
export class Runs {
  private deps: RunsDeps;
  private live = new Map<string, Live>();
  /** Set once shutdown begins: a Session that ends from here on is neither retried nor Flagged. */
  private closing = false;
  /** Sessions whose process has closed but whose verdict is still being reached; shutdown waits for these too. */
  private settling = new Set<Promise<void>>();

  constructor(deps: RunsDeps) {
    this.deps = deps;
  }

  /** The tick's work: start the oldest runnable Tickets while slots are free (spec: Concurrency); the rest stay in line. */
  async startRunnable(): Promise<TickChange[]> {
    const changes: TickChange[] = [];
    const { ready, problems } = this.deps.queue.runnable();
    for (const { ticket, problem } of problems) {
      await this.deps.progress.flag(ticket.id, "pipeline.missing", problem);
      changes.push({ ticket: ticket.id, summary: `Flagged: ${problem}` });
    }
    // Free slots are counted afresh before each start: a launch awaits the tracker when it
    // Flags, and a human Retry or Resume may take a slot meanwhile.
    for (const { ticket, pipeline, stage } of ready) {
      if (this.deps.queue.freeSlots() <= 0) break;
      // A human may have moved the Ticket while an earlier launch awaited (a Skip, say): start only what is still due.
      const fresh = this.deps.tickets.get(ticket.id);
      if (!fresh || fresh.state !== "active" || fresh.stage !== stage.name || fresh.holding_since || fresh.flagged_at) continue;
      changes.push({ ticket: ticket.id, summary: await this.launch(ticket, pipeline, stage, "auto") });
    }
    return changes;
  }

  /**
   * Start the Stage if the Budget allows, else Flag: the one path the tick,
   * auto-retry and the exits share. Returns the change for the tick log.
   * Nothing is awaited before the Session exists, so a caller that has just
   * unflagged the Ticket leaves no gap in which the tick could start it too.
   */
  async launch(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, startedBy: "auto" | "human", resumeFrom: SessionRow | null = null): Promise<string> {
    // A repeating Stage runs only as a Round; with none due and none to re-run it waits for the PR.
    const plan = stage.repeat ? this.deps.review.plan(ticket, stage) : null;
    if (stage.repeat && !plan) return `${stage.name}: nothing to address; the PR is polled each tick`;
    const refusal = this.deps.budgets.refusal(ticket, pipeline, stage);
    if (refusal) {
      await this.deps.progress.flag(ticket.id, refusal.reason, refusal.detail);
      return `Flagged: ${refusal.detail}`;
    }
    // Profiles are live config (ADR 0011): read now, so an edit reaches this Session; a deleted one Flags rather than falls back.
    // The Ticket is read afresh for its override, which a human may have set since the caller read it.
    const profile = ticketProfile(currentConfig(this.deps.home, this.deps.config), this.deps.tickets.get(ticket.id) ?? ticket, pipeline, stage);
    if ("problem" in profile) {
      await this.deps.progress.flag(ticket.id, "profile.missing", profile.problem);
      return `Flagged: ${profile.problem}`;
    }
    try {
      this.start(ticket, pipeline, stage, profile, startedBy, resumeFrom, plan);
      return plan ? `started ${stage.name} Round ${plan.round}` : `started ${stage.name}`;
    } catch (error) {
      // The Runner never started, so there is no Session to blame: runner.unavailable, not outcome.*.
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.progress.flag(ticket.id, "runner.unavailable", detail);
      return `Flagged: ${detail}`;
    }
  }

  /**
   * A fresh Session of the Stage, or with `resumeFrom` one that re-enters that
   * earlier Session where the Runner allows (the Resume exit). Synchronous on
   * purpose: the row and the process both exist when it returns.
   */
  start(ticket: TicketRow, pipeline: Pipeline, stage: RunnerStage, profile: ResolvedProfile, startedBy: "auto" | "human", resumeFrom: SessionRow | null = null, plan: RoundPlan | null = null): SessionRow {
    const { home, sessions, log, budgets, review } = this.deps;
    const running = sessions.running(ticket.id).find((r) => r.mode === "headless");
    if (running) throw new RunError(`${running.stage} is already running on Ticket ${ticket.reference ?? ticket.id}`);
    if (stage.repeat && !plan) plan = review.plan(ticket, stage);
    if (stage.repeat && !plan) throw new RunError(`${stage.name} has no Feedback to address`);
    const switched = resumeFrom ? resumeRefusal(stage.name, resumeFrom, profile) : null;
    if (switched) throw new RunError(switched);
    this.deps.tickets.setRunnableSince(ticket.id, null);
    const adapter = adapterFor(profile.profile.runner);
    const sessionId = randomUUID();
    const sessionsDir = path.join(home.ticketsDir, ticket.id, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stdoutPath = path.join(sessionsDir, `${sessionId}.stdout`);

    const budget = budgets.resolve(ticket, pipeline, stage);
    const wallTimeMs = parseDuration(budget.wallTime.value);
    const remainingSpendUsd = Math.max(0, budget.spend.value - spendOf(sessions.forTicket(ticket.id)));
    // The id re-entered is the earliest one in the chain, so a later Resume of this row finds it too.
    const resumed = resumeFrom ? (resumeFrom.runner_session_id ?? resumeFrom.id) : null;
    const resume = resumed ? { resume: true, runnerSessionId: resumed } : {};
    const feedback = plan ? { feedback: { round: plan.round, prs: plan.prs, marker: plan.marker } } : {};
    const request: RunRequest = { ...requestFor(ticket, stage, profile.profile, this.deps.links.links(ticket.id), this.deps.visits.current(ticket.id)), mode: "headless", sessionId, ...resume, limits: { wallTimeMs, remainingSpendUsd }, ...feedback };
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
      round: plan?.round ?? null,
      profile: sessionProfile(profile.name, profile.profile),
    });
    if (plan) review.opened(ticket, sessionId, plan);
    if (resumed && adapter.sessionIds === "lasso") sessions.setRunnerSession(sessionId, resumed);

    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      detached: true,
      stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let resolve!: (row: SessionRow) => void;
    const done = new Promise<SessionRow>((r) => (resolve = r));
    const live: Live = { child, ticket: ticket.id, stage, request, stdoutPath, fd, stderr: "", messages: new LatestMessageTracker((line) => adapter.message(line)), wallTimer: null, killReason: null, takenOver: false, spawnError: null, notOnPath: false, exit: null, done, resolve };
    this.live.set(sessionId, live);
    if (command.stdin !== undefined) child.stdin!.end(command.stdin);

    child.stdout!.on("data", (chunk: Buffer) => {
      writeSync(fd, chunk);
      this.deps.stdoutWritten?.(ticket.id, sessionId);
      const message = live.messages.feed(chunk);
      if (message !== null) sessions.setLatestMessage(sessionId, message);
    });
    child.stderr!.on("data", (chunk: Buffer) => (live.stderr += chunk.toString()));
    // The pid is recorded at once, so a Lasso killed before the spawn event still leaves a reconcilable row.
    sessions.setPid(sessionId, child.pid ?? null);
    child.once("error", (error) => {
      log.error("session.spawn_failed", { session: sessionId, error: error.message });
      // A Runner missing from PATH is named with the profile that wanted it; any other failure keeps its own words.
      const argv0 = command.argv[0]!;
      live.notOnPath = missingFromPath(argv0, (error as NodeJS.ErrnoException).code);
      live.spawnError = live.notOnPath ? notOnPath(argv0, `profile ${profile.name}`) : `${argv0}: ${error.message}`;
      this.finish(sessionId);
    });
    child.once("close", (code, signal) => {
      log.info("session.exited", { session: sessionId, code, signal });
      live.exit = { code, signal };
      this.finish(sessionId);
    });
    live.wallTimer = setTimeout(() => void this.kill(sessionId, "wall_time"), wallTimeMs);
    live.wallTimer.unref();

    log.info("session.started", { session: sessionId, ticket: ticket.id, stage: stage.name, round: plan?.round ?? null, pid: child.pid, argv0: command.argv[0], resumed: resumeFrom?.id ?? null, profile: profile.name });
    return row;
  }

  /** Abandon: every running Session of the Ticket is killed with that reason; the Ticket is already past caring. */
  async killFor(ticketId: string, reason: EndedReason): Promise<void> {
    const lives = [...this.live.values()].filter((live) => live.ticket === ticketId);
    await Promise.all(lives.map((live) => this.kill(live.request.sessionId, reason).then(() => live.done)));
  }

  /** A human's Stop: kill the process group and record interrupted with reason stop. */
  async stop(session: SessionRow): Promise<SessionRow> {
    const live = this.live.get(session.id);
    if (!live) throw new RunError(`Session ${session.id} is not running`);
    await this.kill(session.id, "stop");
    return live.done;
  }

  /**
   * Take over in terminal: the Session stops as a human's Stop does, but no verdict follows, since the human now
   * works the Stage in a terminal on the same session. One that ends on its own meanwhile is not judged either.
   */
  async takeOver(session: SessionRow): Promise<SessionRow> {
    const live = this.live.get(session.id);
    if (!live) return this.deps.sessions.get(session.id)!;
    live.takenOver = true;
    await this.kill(session.id, "stop");
    return live.done;
  }

  /** Ctrl-C: every running Session ends as interrupted with reason shutdown; its Ticket is left as it was. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.kill(id, "shutdown").then(() => this.live.get(id)?.done)));
    await Promise.all(this.settling);
  }

  /**
   * On startup, rows still marked running belong to a Lasso that is gone: their processes are
   * killed and waited out, then the rows close as shutdown, all before anything new starts in
   * the same worktree.
   */
  async reconcile(): Promise<void> {
    const rows = this.deps.sessions.running().filter((row) => row.mode === "headless");
    await Promise.all(rows.map((row) => (row.pid ? killGroup(row.pid) : Promise.resolve())));
    for (const row of rows) {
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
    const adapter = adapterFor(live.request.profile.runner);
    const stdout = live.spawnError ? "" : readFileSync(live.stdoutPath, "utf8");
    const message = live.messages.flush();
    if (message !== null) this.deps.sessions.setLatestMessage(sessionId, message);
    const parsed = adapter.parse(stdout, live.request);
    // A signal death, whoever sent it (exit 143 is SIGTERM under a shell), is an interruption whatever stdout says.
    const terminated = live.exit?.code === 143 || live.exit?.signal != null;
    const signalName = live.exit?.signal ?? "SIGTERM";
    // A process that ended on its own during shutdown, before it could be killed, counts as cut off too:
    // its verdict cannot be acted on now, so the Session is run again on restart and spends no attempt.
    const reason: EndedReason | null = live.killReason ?? (this.closing && !live.spawnError ? "shutdown" : null);
    const outcome: Outcome = reason || live.spawnError || terminated ? { ...parsed, status: "interrupted" } : parsed;
    const stderr = live.stderr.trim() || null;
    const finalMessage = live.takenOver ? "taken over in a terminal" : outcome.finalMessage ?? (live.killReason ? `killed: ${live.killReason.replace("_", " ")}` : reason ? "ended during shutdown" : (live.spawnError ?? (terminated ? `terminated by ${signalName}` : stderr)));
    const end: SessionEnd = {
      ended_by: reason === "stop" || reason === "abandon" ? "human" : "outcome",
      ended_reason: reason,
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
    if (reason === "shutdown" || this.closing || live.takenOver) verdict = null;
    else if (live.spawnError) verdict = { flag: "runner.unavailable", detail: live.spawnError, ...(live.notOnPath ? { retry: false as const } : {}) };
    else verdict = await this.judge(live, end);
    // Lasso began shutting down while the artifact was checked: the check was cut short, so its verdict is not one.
    if (this.closing) verdict = null;
    const row = this.deps.sessions.end(sessionId, end);
    this.deps.log.info("session.ended", { session: sessionId, ticket: row.ticket, stage: row.stage, outcome: row.outcome, reason: row.ended_reason, cost: row.cost_usd });
    if (verdict) await this.apply(row, verdict);
    live.resolve(row);
    if (verdict) this.deps.ended?.();
  }

  /** Lasso's verdict from the Outcome and the artifact (ADR 0002): advance, or Flag with the reason; a Round asks the PR what it addressed. */
  private async judge(live: Live, end: SessionEnd): Promise<Verdict> {
    const { stage } = live;
    if (end.outcome !== "succeeded") {
      return { flag: end.ended_reason === "wall_time" ? "budget.wall_time" : `outcome.${end.outcome}`, detail: end.final_message };
    }
    const ticket = this.deps.tickets.get(live.ticket);
    if (!ticket) return "wait";
    try {
      if (stage.repeat) return await this.deps.review.judge(ticket, stage, live.request.sessionId);
      const artifact = await checkArtifact(stage.artifact, live.request.cwd, () => this.deps.review.probe(ticket), this.deps.checks.probe(ticket, stage.name), stage.artifactWith);
      return artifact.present ? "advance" : { flag: artifact.broken ? "artifact.error" : "artifact.missing", detail: `${stage.artifact}: ${artifact.detail}` };
    } catch (error) {
      // The PR could not be read (gh down, rate limited): the Session still ends, and a human is told why.
      return { flag: "review.poll_failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async apply(row: SessionRow, verdict: Verdict): Promise<void> {
    const { tickets, progress, budgets, log } = this.deps;
    const ticket = tickets.get(row.ticket);
    if (!ticket || ticket.state !== "active") return;
    if (verdict === "advance") return progress.finished(ticket);
    if (verdict === "wait") return;
    // Interrupted and exhausted runs try again while attempts remain; a run a human stopped, or one that failed, asks instead.
    const retryable = verdict.retry !== false && row.ended_by === "outcome" && (row.outcome === "interrupted" || row.outcome === "exhausted");
    const next = retryable ? progress.runnable(ticket) : null;
    if (next && !("problem" in next)) {
      const refusal = budgets.refusal(ticket, next.pipeline, next.stage);
      if (!refusal) {
        // The ended Session has given its slot back, so the retry normally takes it at once;
        // when the cap has been lowered meanwhile the Ticket joins the line instead.
        if (this.deps.queue.freeSlots() > 0) {
          log.info("session.retry", { ticket: ticket.id, stage: next.stage.name, after: row.id, outcome: row.outcome });
          await this.launch(ticket, next.pipeline, next.stage, "auto");
        } else {
          log.info("session.retry_queued", { ticket: ticket.id, stage: next.stage.name, after: row.id, outcome: row.outcome });
          tickets.setRunnableSince(ticket.id, new Date().toISOString());
        }
        return;
      }
      // The Budget is what stops the retry, so the Flag carries its reason and the Outcome as detail;
      // a Flag already about the Budget (wall time) keeps its own reason. Extend clears either.
      const detail = [refusal.detail, verdict.detail].filter(Boolean).join("; ");
      verdict = verdict.flag.startsWith("budget.") ? { ...verdict, detail } : { flag: refusal.reason, detail };
    }
    await progress.flag(ticket.id, verdict.flag, verdict.detail);
  }
}

/** Kill a leftover process group: SIGTERM, a grace period, then SIGKILL. Only the group is signalled: a lone pid may have been reused since. */
async function killGroup(pid: number): Promise<void> {
  if (!signal(-pid, "SIGTERM")) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (!alive(-pid)) return;
  }
  signal(-pid, "SIGKILL");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
