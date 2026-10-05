import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderPrompt, ticketEnv, profileArgs, jsonLines, str, obj, type RunnerAdapter, type RunRequest, type Command, type Outcome } from "./adapter.ts";
import type { Permission } from "../server/config.ts";

interface Item {
  type?: unknown;
  text?: unknown;
}

/**
 * Codex through `codex exec --json`, workspace-write with approvals never
 * unless the profile sets a permission.
 * Codex assigns its own thread id: headless runs report it in the first
 * event, and a terminal launch is recovered afterwards by `findSession`
 * from the thread table under CODEX_HOME by cwd and creation time. Skills
 * are link-form mentions by absolute path, which Codex resolves itself:
 * a path outside its skill roots is ignored without a word, so a Stage
 * whose skills live elsewhere runs under a profile with `skills_dir`.
 */

/** A profile's permission as Codex's flags, each accepted top-level, on exec and on resume (research/runner-cli-flags). */
const PERMISSION_FLAGS: Record<Permission, string[]> = {
  auto: ["--approve-for-me"],
  edits: ["-s", "workspace-write"],
  full: ["--dangerously-bypass-approvals-and-sandbox"],
};

/** Codex's thread index; the name carries its schema version, so a newer Codex leaves resume finding nothing. */
const STATE_DB = "state_5.sqlite";
export const codexAdapter: RunnerAdapter = {
  name: "codex",
  honours: [],
  sessionIds: "runner",

  command(request: RunRequest): Command {
    const skillsDir = request.profile.skills_dir ?? path.join(homedir(), ".agents", "skills");
    const prompt = renderPrompt(request, (name) => `[$${name}](${path.join(skillsDir, name, "SKILL.md")})`);
    // A terminal runs under the shell's environment: the home Lasso reads threads from must be the one Codex writes.
    const env = { ...ticketEnv(request), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
    const args = profileArgs(request.profile, "-m", (level) => ["-c", `model_reasoning_effort=${level}`]);
    // Codex refuses a repeated -m, -s or -a, so a profile's permission is emitted alone in place of the baseline,
    // and the baseline -a never (a no-op under exec) goes with it: --dangerously-bypass-approvals-and-sandbox refuses -a.
    const permission = request.profile.permission;
    const sandbox = permission ? PERMISSION_FLAGS[permission] : ["-s", "workspace-write"];
    const approval = permission ? [] : ["-a", "never"];
    if (request.mode === "terminal") {
      if (request.resume) return { argv: ["codex", "resume", request.runnerSessionId ?? request.sessionId, ...sandbox, ...args], cwd: request.cwd, env };
      return { argv: ["codex", ...sandbox, ...args, prompt], cwd: request.cwd, env };
    }
    // `exec resume` takes no sandbox, approval or cwd of its own: the permission goes top-level and the cwd is the process's.
    if (request.resume) return { argv: ["codex", ...approval, ...sandbox, "exec", "resume", "--json", ...args, request.runnerSessionId ?? request.sessionId, prompt], cwd: request.cwd, env };
    return { argv: ["codex", ...approval, "exec", "--json", "-C", request.cwd, ...sandbox, ...args, prompt], cwd: request.cwd, env };
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
