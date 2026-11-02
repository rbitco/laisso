import { homedir } from "node:os";
import path from "node:path";
import { renderPrompt, ticketEnv, profileArgs, jsonLines, str, obj, type RunnerAdapter, type RunRequest, type Command, type Outcome, type OutcomeStatus } from "./adapter.ts";

interface Header {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
}

interface AssistantMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
}

/**
 * Pi through `pi -p --mode json`. The first line is the session header;
 * once `agent_end` says the loop finished, the last assistant `message_end`
 * is the Outcome. Pi takes the session id Laisso chose, has no approval
 * prompt (so a profile's permission is ignored) and no budget flags, and
 * is told to trust the worktree so project skills load.
 */
export const piAdapter: RunnerAdapter = {
  name: "pi",
  honours: [],
  sessionIds: "laisso",

  command(request: RunRequest): Command {
    const prompt = renderPrompt(request, (name) => `/skill:${name}`);
    const env = ticketEnv(request);
    // Pi has no approval layer, so a profile's permission has nothing to map to.
    const args = profileArgs(request.profile, "--model", (level) => ["--thinking", level]);
    if (request.mode === "terminal") {
      if (request.resume) return { argv: ["pi", "--session-id", request.runnerSessionId ?? request.sessionId, "-a", ...args], cwd: request.cwd, env };
      const argv = ["pi", "--session-id", request.sessionId];
      if (request.name) argv.push("-n", request.name);
      argv.push("-a", ...args, prompt);
      return { argv, cwd: request.cwd, env };
    }
    // Pi re-enters a session by the same flag that names a new one; on resume that is the earlier Session's id.
    const session = request.resume ? request.runnerSessionId ?? request.sessionId : request.sessionId;
    return { argv: ["pi", "-p", "--mode", "json", "--session-id", session, "-a", ...args, prompt], cwd: request.cwd, env };
  },

  interactive(prompt, profile, cwd) {
    return { argv: ["pi", "-a", ...profileArgs(profile, "--model", (level) => ["--thinking", level]), prompt], cwd, env: {} };
  },

  parse(stdout: string, request: Pick<RunRequest, "cwd" | "sessionId">): Outcome {
    const records = jsonLines(stdout);
    const header = records.find((r) => r.type === "session") as Header | undefined;
    const sessionId = str(header?.id) ?? request.sessionId;
    const timestamp = str(header?.timestamp);
    const dir = sessionsDir(request.cwd);
    const transcriptPath = timestamp ? path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`) : dir;
    const last = records
      .filter((r) => r.type === "message_end")
      .map((r) => r.message as AssistantMessage | undefined)
      .filter((m): m is AssistantMessage => m?.role === "assistant")
      .at(-1);
    // Without agent_end the loop was cut off, whatever the last message said.
    const finished = records.some((r) => r.type === "agent_end");
    if (!last || !finished) return { status: "interrupted", sessionId, finalMessage: null, usage: null, costUsd: null, transcriptPath };
    const usage = obj(last.usage);
    const cost = obj(usage?.cost)?.total;
    return {
      status: statusOf(last),
      sessionId,
      finalMessage: str(last.errorMessage) ?? text(last.content),
      usage,
      costUsd: typeof cost === "number" ? cost : null,
      transcriptPath,
    };
  },

  // An assistant message once it ends; the many message_update lines that stream it are passed over before any JSON is parsed.
  message(line: string): string | null {
    if (!line.startsWith('{"type":"message_end"')) return null;
    const message = obj(jsonLines(line)[0]?.message);
    return message?.role === "assistant" ? text(message.content) : null;
  },

  /** The directory Pi keeps this worktree's sessions in; the file is named by the run's own timestamp. */
  transcriptPath(request): string {
    return sessionsDir(request.cwd);
  },

  findSession(): string | null {
    return null;
  },
};

/** Pi's own encoding of a cwd into a directory name under ~/.pi/agent/sessions. */
function sessionsDir(cwd: string): string {
  return path.join(homedir(), ".pi", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function statusOf(message: AssistantMessage): OutcomeStatus {
  switch (message.stopReason) {
    case "stop":
      return "succeeded";
    // A tool call with no reply after it, or an abort: the turn never finished.
    case "toolUse":
    case "aborted":
      return "interrupted";
    case "length":
      return "exhausted";
    default:
      return "failed";
  }
}

/** The text blocks of a message joined, or null when it said nothing. */
function text(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text").map((b) => String((b as { text?: unknown }).text ?? ""));
  const joined = parts.join("\n").trim();
  return joined || null;
}
