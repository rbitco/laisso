import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findPackageRoot, PackageRootNotFound, PACKAGE_NAME } from "../src/package-root.ts";

async function layout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "laisso-pkg-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

const laissoPackage = (version: string) => JSON.stringify({ name: PACKAGE_NAME, version });

// Laisso finds its own version and dashboard by walking up to its package.json, from source and from the bundle alike.
describe("the package root", () => {
  it("is found from a source checkout's module directory", async () => {
    const root = await layout({ "package.json": laissoPackage("0.0.0-dev"), "src/package-root.ts": "" });
    expect(findPackageRoot(path.join(root, "src"))).toEqual({ root, version: "0.0.0-dev", dashboardDir: path.join(root, "dist", "dashboard"), skillDir: path.join(root, "skills", "laisso"), checkout: true });
  });

  it("is found from an installed bundle, past the package.json files of the prefix around it", async () => {
    const prefix = await layout({
      "package.json": JSON.stringify({ name: "someone-else", version: "9.9.9" }),
      "lib/node_modules/laisso/package.json": laissoPackage("1.2.3"),
      "lib/node_modules/laisso/dist/laisso.js": "",
      "lib/node_modules/laisso/node_modules/yaml/package.json": JSON.stringify({ name: "yaml", version: "2.0.0" }),
    });
    const root = path.join(prefix, "lib/node_modules/laisso");
    expect(findPackageRoot(path.join(root, "dist"))).toEqual({ root, version: "1.2.3", dashboardDir: path.join(root, "dist", "dashboard"), skillDir: path.join(root, "skills", "laisso"), checkout: false });
  });

  it("walks past a package.json that is not Laisso's", async () => {
    const root = await layout({ "package.json": laissoPackage("1.0.0"), "src/inner/package.json": JSON.stringify({ name: "other", version: "5.0.0" }) });
    expect(findPackageRoot(path.join(root, "src", "inner")).root).toBe(root);
  });

  it("errors naming the package when no Laisso package.json is above the start", async () => {
    const dir = await layout({ "package.json": JSON.stringify({ name: "@rbitco/laisso", version: "1.0.0" }) });
    expect(() => findPackageRoot(dir)).toThrow(PackageRootNotFound);
    expect(() => findPackageRoot(dir)).toThrow(/cannot find Laisso's package\.json \(name laisso\)/);
  });

  it("is this repo when run from source", () => {
    const found = findPackageRoot();
    expect(found.root).toBe(path.resolve(import.meta.dirname, ".."));
    expect(found.checkout).toBe(true);
  });
});
