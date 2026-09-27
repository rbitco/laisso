import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderPrompt, ticketEnv, extraArgs, jsonLines, str, obj, type RunnerAdapter, type RunRequest, type Command, type Outcome } from "./adapter.ts";

interface Item {
  type?: unknown;
  text?: unknown;
}

/**
 * Codex through `codex exec --json`, workspace-write with approvals never.
 * Codex assigns its own thread id: headless runs report it in the first
 * event, and a terminal launch is recovered afterwards by `findSession`
 * from the thread table under CODEX_HOME by cwd and creation time. Skills
 * are link-form mentions by absolute path, which Codex resolves itself:
 * a path outside its skill roots is ignored without a word, so a Stage
 * whose skills live elsewhere sets `runnerOptions.skillsDir`.
 */

/** Codex's thread index; the name carries its schema version, so a newer Codex leaves resume finding nothing. */
const STATE_DB = "state_5.sqlite";
export const codexAdapter: RunnerAdapter = {
  name: "codex",
  honours: [],
  sessionIds: "runner",

  command(request: RunRequest): Command {
    const skillsDir = typeof request.runnerOptions.skillsDir === "string" ? request.runnerOptions.skillsDir : path.join(homedir(), ".agents", "skills");
    const prompt = renderPrompt(request, (name) => `[$${name}](${path.join(skillsDir, name, "SKILL.md")})`);
    // A terminal runs under the shell's environment: the home Lasso reads threads from must be the one Codex writes.
    const env = { ...ticketEnv(request), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
    const args = extraArgs(request.runnerOptions);
    if (request.mode === "terminal") {
      if (request.resume) return { argv: ["codex", "resume", request.runnerSessionId ?? request.sessionId, "-s", "workspace-write", ...args], cwd: request.cwd, env };
      return { argv: ["codex", "-s", "workspace-write", ...args, prompt], cwd: request.cwd, env };
    }
    return { argv: ["codex", "-a", "never", "exec", "--json", "-C", request.cwd, "-s", "workspace-write", ...args, prompt], cwd: request.cwd, env };
  },

  parse(stdout: string): Outcome {
    const records = jsonLines(stdout);
    const started = records.find((r) => r.type === "thread.started");
    const sessionId = str(started?.thread_id);
    // Cut off mid-turn: the last error Codex reported is the best detail there is.
    const lastError = records.filter((r) => r.type === "error").at(-1);
    const none: Outcome = { status: "interrupted", sessionId, finalMessage: str(lastError?.message), usage: null, costUsd: null, transcriptPath: null };
    const completed = records.filter((r) => r.type === "turn.completed").at(-1);
    const failed = records.filter((r) => r.type === "turn.failed").at(-1);
    if (failed) return { ...none, status: "failed", finalMessage: str(obj(failed.error)?.message) ?? "turn failed" };
    if (!completed) return none;
    const messages = records
      .filter((r) => r.type === "item.completed")
      .map((r) => r.item as Item | undefined)
      .filter((item): item is Item => item?.type === "agent_message");
    return {
      ...none,
      status: "succeeded",
      finalMessage: str(messages.at(-1)?.text),
      usage: obj(completed.usage),
    };
  },

  /** The rollout file is named by Codex at thread creation; nothing to promise before then. */
  transcriptPath(): null {
    return null;
  },

  findSession({ cwd, launchedAfter }): string | null {
    const file = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), STATE_DB);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const row = db
        .prepare(
          `SELECT id FROM threads WHERE cwd = ? AND archived = 0 AND COALESCE(created_at_ms, created_at * 1000) >= ?
           ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC, id DESC LIMIT 1`,
        )
        .get(cwd, launchedAfter.getTime()) as { id?: unknown } | undefined;
      return str(row?.id);
    } catch {
      return null;
    } finally {
      db.close();
    }
  },
};
