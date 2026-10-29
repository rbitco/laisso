import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long one git command may run before it is killed, so a hung fetch or push cannot stall a tick. */
export const GIT_TIMEOUT_MS = 120_000;

export class GitError extends Error {}

/** Thin, promise-based git over a checkout. Lasso owns worktrees; Runners never touch them (ADR 0003). */
export class Git {
  cwd: string;
  timeoutMs: number;

  constructor(cwd: string, timeoutMs: number = GIT_TIMEOUT_MS) {
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  async exec(args: string[], cwd: string = this.cwd): Promise<string> {
    try {
      const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: this.timeoutMs, killSignal: "SIGKILL" });
      return stdout.trim();
    } catch (error) {
      const e = error as { stderr?: string; message?: string; killed?: boolean; signal?: string | null };
      if (e.killed && e.signal === "SIGKILL") throw new GitError(`git ${args.join(" ")} timed out after ${this.timeoutMs / 1000}s in ${cwd}`);
      throw new GitError(`git ${args.join(" ")} failed in ${cwd}: ${(e.stderr || e.message || "").trim()}`);
    }
  }

  fetch(): Promise<string> {
    return this.exec(["fetch", "--quiet", "--prune", "origin"]);
  }

  /** origin's default branch, from origin/HEAD or by asking the remote. */
  async defaultBranch(): Promise<string> {
    try {
      const ref = await this.exec(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      return ref.replace(/^origin\//, "");
    } catch {
      const out = await this.exec(["ls-remote", "--symref", "origin", "HEAD"]);
      const m = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out);
      if (!m) throw new GitError("cannot determine origin's default branch");
      return m[1]!;
    }
  }

  /** Whether a fully qualified ref (refs/heads/x, refs/remotes/origin/x) exists. */
  async refExists(ref: string): Promise<boolean> {
    try {
      await this.exec(["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The head commit of PR `number` on origin, fetched so a branch can start
   * there. Read from refs/pull/N/head, which GitHub keeps for every PR, fork or
   * not, so no branch of the PR's author is ever tracked or pushed to.
   */
  async prHead(number: number): Promise<string> {
    const ref = `refs/pull/${number}/head`;
    const sha = (await this.exec(["ls-remote", "origin", ref])).split(/\s/)[0];
    if (!sha) throw new GitError(`origin has no ${ref}`);
    await this.exec(["fetch", "--quiet", "origin", ref]);
    return sha;
  }

  /**
   * Make a worktree for `branch` at `dir`: an existing local or remote branch
   * is checked out; otherwise the branch is created from the head of origin's
   * PR `fromPr` when given, else from origin's default. A branch started at a
   * PR tracks nothing, so a push names Lasso's branch on origin and nothing else.
   * Returns whether the branch already existed.
   */
  async addWorktree(dir: string, branch: string, fromPr?: number): Promise<{ existed: boolean }> {
    await this.fetch();
    if (await this.refExists(`refs/heads/${branch}`)) {
      await this.exec(["worktree", "add", "--quiet", dir, branch]);
      return { existed: true };
    }
    if (await this.refExists(`refs/remotes/origin/${branch}`)) {
      await this.exec(["worktree", "add", "--quiet", "--track", "-b", branch, dir, `origin/${branch}`]);
      return { existed: true };
    }
    if (fromPr !== undefined) {
      await this.exec(["worktree", "add", "--quiet", "--no-track", "-b", branch, dir, await this.prHead(fromPr)]);
      return { existed: false };
    }
    const base = await this.defaultBranch();
    await this.exec(["worktree", "add", "--quiet", "-b", branch, dir, `origin/${base}`]);
    return { existed: false };
  }

  /** Remove a worktree, uncommitted changes and all; one already gone from disk is pruned instead. */
  async removeWorktree(dir: string): Promise<void> {
    try {
      await this.exec(["worktree", "remove", "--force", dir]);
    } catch (error) {
      if (!/not a working tree|does not exist|No such file/i.test((error as Error).message)) throw error;
      await this.exec(["worktree", "prune"]);
    }
  }

  /** Delete a local branch whatever its merge state; the worktree that had it must be gone. */
  deleteBranch(branch: string): Promise<string> {
    return this.exec(["branch", "-D", "--quiet", branch]);
  }

  /** Whether origin has the branch, as of a fresh fetch. */
  async remoteBranchExists(branch: string): Promise<boolean> {
    await this.fetch();
    return this.refExists(`refs/remotes/origin/${branch}`);
  }

  /** Commit everything in a worktree under `message`; false when there was nothing to commit. Falls back to Lasso's own identity where git has none. */
  async commitAll(dir: string, message: string): Promise<boolean> {
    if (!(await this.exec(["status", "--porcelain"], dir))) return false;
    await this.exec(["add", "-A"], dir);
    const identity = (await this.exec(["config", "--get", "user.email"], dir).catch(() => "")) ? [] : ["-c", "user.name=Lasso", "-c", "user.email=lasso@localhost"];
    // A salvage commit is not the repo's hooks to refuse.
    await this.exec([...identity, "commit", "--quiet", "--no-verify", "-m", message], dir);
    return true;
  }

  push(dir: string, branch: string): Promise<string> {
    return this.exec(["push", "--quiet", "origin", branch], dir);
  }
}
