import { describe, it, expect, vi } from "vitest";
import { versionNotice, noticeText, type VersionNotice } from "../src/version-notice.ts";
import { VersionCheck, type VersionCheckDeps } from "../src/server/version-check.ts";
import type { Logger } from "../src/server/log.ts";

const none: VersionNotice = { kind: "none" };
const available = (version: string): VersionNotice => ({ kind: "available", version });
const restart = (version: string): VersionNotice => ({ kind: "restart", version });

// Laisso tells Matt when a newer version is published, or when he has upgraded but still runs the old process.
describe("the version notice", () => {
  it.each<[string, string, string, string | null, VersionNotice]>([
    ["all the same", "1.2.0", "1.2.0", "1.2.0", none],
    ["latest unknown, nothing installed", "1.2.0", "1.2.0", null, none],
    ["a newer patch published", "1.2.0", "1.2.0", "1.2.1", available("1.2.1")],
    ["a newer minor published", "1.2.9", "1.2.9", "1.10.0", available("1.10.0")],
    ["a newer major published", "1.9.9", "1.9.9", "2.0.0", available("2.0.0")],
    ["an older version published", "1.2.0", "1.2.0", "1.1.9", none],
    ["installed and published newer", "1.2.0", "1.3.0", "1.3.0", restart("1.3.0")],
    ["installed newer, latest unknown", "1.2.0", "1.3.0", null, restart("1.3.0")],
    ["restart wins even when a still newer one is published", "1.2.0", "1.3.0", "1.4.0", restart("1.3.0")],
    ["installed older than running", "1.2.0", "1.1.0", "1.2.0", none],
    ["dev checkout, newer published", "0.0.0-dev", "0.0.0-dev", "9.0.0", none],
    ["dev checkout, newer on disk", "0.0.0-dev", "9.0.0", "9.0.0", none],
    ["dev checkout, latest unknown", "0.0.0-dev", "0.0.0-dev", null, none],
    ["a release above its own prerelease", "1.3.0-rc.1", "1.3.0-rc.1", "1.3.0", available("1.3.0")],
    ["a later prerelease, compared numerically", "1.3.0-rc.2", "1.3.0-rc.2", "1.3.0-rc.10", available("1.3.0-rc.10")],
    ["a published version that is not semver", "1.2.0", "1.2.0", "not a version", none],
  ])("%s: running %s, on disk %s, latest %s", (_, running, onDisk, latest, expected) => {
    expect(versionNotice(running, onDisk, latest)).toEqual(expected);
  });

  it("says how to upgrade, how to finish an upgrade, or nothing", () => {
    expect(noticeText(available("1.3.0"))).toBe("v1.3.0 available: npm update -g @rbitco/laisso");
    expect(noticeText(restart("1.3.0"))).toBe("v1.3.0 installed: restart laisso to use it");
    expect(noticeText(none)).toBeNull();
  });
});

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A check running 1.2.0 with 1.2.0 on disk and the registry unreachable, unless told otherwise. */
function check(over: Partial<VersionCheckDeps>) {
  const changed = vi.fn();
  const latest = vi.fn(over.latest ?? (async () => null));
  const versions = new VersionCheck({ running: "1.2.0", onDisk: () => "1.2.0", log: quiet, changed, ...over, latest });
  return { versions, changed, latest };
}

// The check holds the notice in memory, reading the package on disk again and asking the registry each time.
describe("the version check", () => {
  it("holds the notice from the last check, re-reading the package on disk each time", async () => {
    let disk = "1.2.0";
    const { versions } = check({ onDisk: () => disk, latest: async () => "1.3.0" });
    expect(versions.current()).toEqual(none);
    expect(await versions.check()).toEqual(available("1.3.0"));
    disk = "1.3.0";
    await versions.check();
    expect(versions.current()).toEqual(restart("1.3.0"));
  });

  it("says nothing when the registry cannot be asked or the package on disk cannot be read", async () => {
    const { versions } = check({ onDisk: () => null, latest: () => Promise.reject(new Error("getaddrinfo ENOTFOUND npm.matty.rocks")) });
    expect(await versions.check()).toEqual(none);
  });

  it("tells the dashboard only when the notice changes", async () => {
    let latest: string | null = "1.3.0";
    const { versions, changed } = check({ latest: async () => latest });
    await versions.check();
    await versions.check();
    expect(changed).toHaveBeenCalledTimes(1);
    latest = null;
    await versions.check();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("checks at start and every 24 hours until stopped", async () => {
    vi.useFakeTimers();
    try {
      const { versions, latest } = check({ latest: async () => "1.3.0" });
      versions.start();
      expect(latest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
      expect(latest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(latest).toHaveBeenCalledTimes(2);
      versions.stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(latest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks the registry from a dev checkout", async () => {
    const { versions, latest } = check({ running: "0.0.0-dev", latest: async () => "9.0.0" });
    versions.start();
    expect(await versions.check()).toEqual(none);
    versions.stop();
    expect(latest).not.toHaveBeenCalled();
  });
});
