import { execFile } from "node:child_process";
import { PACKAGE_NAME } from "../package-root.ts";
import { DEV_VERSION, versionNotice, type VersionNotice } from "../version-notice.ts";
import type { Logger } from "./log.ts";

/** How often Laisso asks the registry again after the check at start. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Offline npm can retry for minutes; past this the latest version is simply unknown. */
const NPM_TIMEOUT_MS = 30_000;

/** The latest published version through the machine's own npm config, or null on any failure (offline, registry down, no npm). */
export function npmLatest(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("npm", ["view", PACKAGE_NAME, "version"], { encoding: "utf8", timeout: NPM_TIMEOUT_MS }, (error, stdout) => {
      const version = (stdout ?? "").trim();
      resolve(error || !version ? null : version);
    });
  });
}

export interface VersionCheckDeps {
  running: string;
  /** The version of the package on disk now; null when it cannot be read, as mid-upgrade. */
  onDisk: () => string | null;
  latest: () => Promise<string | null>;
  log: Logger;
  /** Hears whenever `current()` would answer differently. */
  changed?: () => void;
}

/**
 * The version notice, held in memory: checked at start and every 24 hours. It only ever tells; Laisso never restarts
 * itself and posts no OS notification. A dev checkout never checks at all.
 */
export class VersionCheck {
  private notice: VersionNotice = { kind: "none" };
  private timer: NodeJS.Timeout | null = null;
  private deps: VersionCheckDeps;

  constructor(deps: VersionCheckDeps) {
    this.deps = deps;
  }

  current(): VersionNotice {
    return this.notice;
  }

  async check(): Promise<VersionNotice> {
    const { running } = this.deps;
    if (running === DEV_VERSION) return this.notice;
    const latest = await this.deps.latest().catch(() => null);
    const next = versionNotice(running, this.deps.onDisk() ?? running, latest);
    const was = this.notice;
    this.notice = next;
    if (JSON.stringify(next) !== JSON.stringify(was)) {
      if (next.kind !== "none") this.deps.log.info("version.notice", { kind: next.kind, version: next.version, running });
      this.deps.changed?.();
    }
    return next;
  }

  /** Check now and every CHECK_INTERVAL_MS after; neither waits on the registry nor holds the process open. */
  start(): void {
    if (this.deps.running === DEV_VERSION) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
