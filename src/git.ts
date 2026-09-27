import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GitError extends Error {}

/** Thin, promise-based git over a checkout. Lasso owns worktrees; Runners never touch them (ADR 0003). */
export class Git {
  cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async exec(args: string[], cwd: string = this.cwd): Promise<string> {
    try {
      const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const e = error as { stderr?: string; message?: string };
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
   * Make a worktree for `branch` at `dir`: an existing local or remote branch
   * is checked out; otherwise the branch is created from origin's default.
   * Returns whether the branch already existed.
   */
  async addWorktree(dir: string, branch: string): Promise<{ existed: boolean }> {
    await this.fetch();
    if (await this.refExists(`refs/heads/${branch}`)) {
      await this.exec(["worktree", "add", "--quiet", dir, branch]);
      return { existed: true };
    }
    if (await this.refExists(`refs/remotes/origin/${branch}`)) {
      await this.exec(["worktree", "add", "--quiet", "--track", "-b", branch, dir, `origin/${branch}`]);
      return { existed: true };
    }
    const base = await this.defaultBranch();
    await this.exec(["worktree", "add", "--quiet", "-b", branch, dir, `origin/${base}`]);
    return { existed: false };
  }

  async removeWorktree(dir: string): Promise<void> {
    await this.exec(["worktree", "remove", "--force", dir]);
  }
}
