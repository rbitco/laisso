import { homedir } from "node:os";
import path from "node:path";
import { renderPrompt, ticketEnv, extraArgs, type RunnerAdapter, type RunRequest, type Command, type Outcome, type OutcomeStatus } from "./adapter.ts";

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

  command(request: RunRequest): Command {
    const prompt = renderPrompt(request, (name) => `/${name}`);
    const env = ticketEnv(request);
    if (request.mode === "terminal") {
      if (request.resume) {
        return { argv: ["claude", "--resume", request.sessionId, "--permission-mode", "acceptEdits", ...extraArgs(request.runnerOptions)], cwd: request.cwd, env };
      }
      const argv = ["claude", "--session-id", request.sessionId, "--permission-mode", "acceptEdits"];
      if (request.name) argv.push("--name", request.name);
      argv.push(...extraArgs(request.runnerOptions), prompt);
      return { argv, cwd: request.cwd, env };
    }
    const argv = [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--session-id",
      request.sessionId,
    ];
    if (request.limits.remainingSpendUsd !== undefined) argv.push("--max-budget-usd", String(request.limits.remainingSpendUsd));
    argv.push(...extraArgs(request.runnerOptions));
    return { argv, cwd: request.cwd, env };
  },

  parse(stdout: string, request: Pick<RunRequest, "cwd" | "sessionId">): Outcome {
    const records = stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
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
      usage: result.usage && typeof result.usage === "object" ? (result.usage as Record<string, unknown>) : null,
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

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
