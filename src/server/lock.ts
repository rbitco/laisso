import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { LaissoHome } from "./home.ts";

export interface LockHolder {
  pid: number;
  port: number;
}

export class AlreadyRunning extends Error {
  holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`laisso already running at http://localhost:${holder.port} (pid ${holder.pid})`);
    this.holder = holder;
  }
}

/**
 * Take the pid lock. A stale file (its pid is dead) is removed first; the lock
 * is then created exclusively, so two starts racing for it cannot both win.
 * Throws AlreadyRunning when a live process holds it.
 */
export function acquireLock(home: LaissoHome, port: number): () => void {
  const existing = readLock(home);
  if (existing && isAlive(existing.pid) && existing.pid !== process.pid) throw new AlreadyRunning(existing);
  if (existing) unlinkSync(home.pidFile);
  try {
    writeFileSync(home.pidFile, JSON.stringify({ pid: process.pid, port }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readLock(home);
    if (winner) throw new AlreadyRunning(winner);
    throw error;
  }
  return () => {
    const current = readLock(home);
    if (current?.pid === process.pid) {
      try {
        unlinkSync(home.pidFile);
      } catch {
        // already gone
      }
    }
  };
}

export function readLock(home: LaissoHome): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(home.pidFile, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
    return { pid: parsed.pid, port: parsed.port };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
