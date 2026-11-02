import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findPackageRoot } from "../src/package-root.ts";
import { smokeTest } from "../scripts/smoke-test.ts";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// The package as npm installs it: packed, installed into a fresh prefix, started from there (the release smoke test).
describe("the packed package", () => {
  it("installs globally, starts, and serves its version and dashboard", { timeout: 180_000 }, async () => {
    const out = await mkdtemp(path.join(tmpdir(), "laisso-pack-"));
    try {
      // The global setup has built the dashboard; prepack would rebuild it, emptying dist/dashboard under the other
      // tests' running servers, so only the bundle is built here and the pack skips its scripts.
      await run("npm", ["run", "bundle"], { cwd: REPO_ROOT });
      const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: REPO_ROOT });
      const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const files = packed!.files.map((f) => f.path);
      expect(files).toEqual(expect.arrayContaining(["package.json", "dist/laisso.js", "dist/laisso.js.map", "dist/dashboard/index.html"]));
      // The Laisso skill ships whole, so `laisso skill install` can copy it from the installed package.
      const skill = readdirSync(findPackageRoot().skillDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(REPO_ROOT, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
      expect(skill).toContain("skills/laisso/SKILL.md");
      expect(files).toEqual(expect.arrayContaining(skill));
      expect(files.filter((f) => !f.startsWith("dist/") && !f.startsWith("skills/") && f !== "package.json" && f !== "README.md")).toEqual([]);
      await smokeTest({ tarball: path.join(out, packed!.filename), version: findPackageRoot().version });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
