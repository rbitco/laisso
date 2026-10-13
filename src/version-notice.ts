import { PACKAGE_NAME } from "./package-root.ts";

/** The version a source checkout reports; it never nags about upgrades. */
export const DEV_VERSION = "0.0.0-dev";

/**
 * What Lasso has to say about its own version: nothing, a newer version published (`available`), or a newer version
 * already installed on disk while this process still runs the old one (`restart`). `version` is the newer one.
 */
export type VersionNotice = { kind: "none" } | { kind: "available" | "restart"; version: string };

/**
 * The decision from the running version, the version of the package on disk now, and the latest published version
 * (null when it could not be learned). An upgrade already installed wins over one merely published, since restarting
 * is all it takes. A dev checkout always says nothing.
 */
export function versionNotice(running: string, onDisk: string, latest: string | null): VersionNotice {
  if (running === DEV_VERSION) return { kind: "none" };
  if (newer(onDisk, running)) return { kind: "restart", version: onDisk };
  if (latest !== null && newer(latest, running)) return { kind: "available", version: latest };
  return { kind: "none" };
}

/** The line the dashboard header and `lasso status` show, or null when there is nothing to say. */
export function noticeText(notice: VersionNotice): string | null {
  if (notice.kind === "available") return `v${notice.version} available: npm update -g ${PACKAGE_NAME}`;
  if (notice.kind === "restart") return `v${notice.version} installed: restart lasso to use it`;
  return null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `a` is a later semver than `b`; a version that does not parse is never newer, nor anything newer than it. */
function newer(a: string, b: string): boolean {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  }
  return comparePrerelease(x[4], y[4]) > 0;
}

/** Semver's prerelease order: a release is above any of its prereleases; identifiers compare numerically when both are numbers. */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const xs = a.split(".");
  const ys = b.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
