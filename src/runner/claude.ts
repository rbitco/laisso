import { homedir } from "node:os";
import path from "node:path";
import { renderPrompt, ticketEnv, profileArgs, jsonLines, str, obj, type RunnerAdapter, type RunRequest, type Command, type Outcome, type OutcomeStatus } from "./adapter.ts";
import type { Permission } from "../server/config.ts";

/** A profile's permission as Claude's --permission-mode. */
const PERMISSION_MODES: Record<Permission, string> = { auto: "auto", edits: "acceptEdits", full: "bypassPermissions" };

interface ResultRecord {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  errors?: unknown;
  session_id?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
}

/**
 * Claude Code through `claude -p`. Headless runs stream JSON so stdout can be
 * tailed live; the last `result` record is the Outcome. Lasso chooses the
 * session id up front, so `findSession` has nothing to find.
 */
export const claudeAdapter: RunnerAdapter = {
  name: "claude",
  honours: ["remainingSpendUsd"],
  sessionIds: "lasso",

  command(request: RunRequest): Command {
    const prompt = renderPrompt(request, (name) => `/${name}`);
    const env = ticketEnv(request);
    const extra = profileArgs(request.profile, "--model", (level) => ["--effort", level]);
    const permission = request.profile.permission;
    if (request.mode === "terminal") {
      // Terminal baseline: a person is there to answer what acceptEdits asks.
      const mode = permission ? PERMISSION_MODES[permission] : "acceptEdits";
      if (request.resume) {
        return { argv: ["claude", "--resume", request.sessionId, "--permission-mode", mode, ...extra], cwd: request.cwd, env };
      }
      const argv = ["claude", "--session-id", request.sessionId, "--permission-mode", mode];
      if (request.name) argv.push("--name", request.name);
      argv.push(...extra, prompt);
      return { argv, cwd: request.cwd, env };
    }
    // Headless baseline: auto mode lets the Runner test, lint and commit, and refuses what its classifier finds risky;
    // with prompts off, anything it would ask about is refused rather than waiting. A person at a terminal Session answers prompts.
    // A profile's permission replaces the mode; prompts stay off whatever it is, since nobody is there to answer.
    const mode = permission ? PERMISSION_MODES[permission] : "auto";
    const argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", mode, "--permission-prompts", "none"];
    // Resume re-enters the earlier session, which keeps its id; a fresh run takes the id Lasso chose.
    argv.push(...(request.resume ? ["--resume", request.runnerSessionId ?? request.sessionId] : ["--session-id", request.sessionId]));
    if (request.limits.remainingSpendUsd !== undefined) argv.push("--max-budget-usd", String(request.limits.remainingSpendUsd));
    argv.push(...extra);
    return { argv, cwd: request.cwd, env };
  },

  parse(stdout: string, request: Pick<RunRequest, "cwd" | "sessionId">): Outcome {
    const records = jsonLines(stdout);
    const result = records.filter((r) => r.type === "result").at(-1) as ResultRecord | undefined;
    const init = records.find((r) => r.type === "system" && r.subtype === "init");
    const sessionId = str(result?.session_id) ?? str(init?.session_id) ?? request.sessionId;
    const transcriptPath = claudeAdapter.transcriptPath({ cwd: request.cwd, sessionId });
    if (!result) return { status: "interrupted", sessionId, finalMessage: null, usage: null, costUsd: null, transcriptPath };
    const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
    const finalMessage = str(result.result) ?? (errors.length ? errors.join("\n") : null);
    return {
      status: statusOf(result),
      sessionId,
      finalMessage,
      usage: obj(result.usage),
      costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
      transcriptPath,
    };
  },

  transcriptPath(request): string {
    return path.join(homedir(), ".claude", "projects", request.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${request.sessionId}.jsonl`);
  },

  findSession(): string | null {
    return null;
  },
};

function statusOf(result: ResultRecord): OutcomeStatus {
  if (result.subtype === "success" && !result.is_error) return "succeeded";
  if (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd") return "exhausted";
  return "failed";
}
