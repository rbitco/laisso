import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Dashboard, DashboardMissing } from "../src/dashboard/page.ts";

// Lasso serves the dashboard Vite built (ADR 0012) and refuses to start without it.
describe("the built dashboard", () => {
  it("refuses a directory with no built page, naming the command that builds it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lasso-dist-"));
    expect(() => new Dashboard(dir)).toThrow(DashboardMissing);
    expect(() => new Dashboard(dir)).toThrow(/not built .*run pnpm build/);
  });

  it("serves the page at / and each bundled file at its path, with its type", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lasso-dist-"));
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html>");
    await writeFile(path.join(dir, "assets", "index-abc.js"), "export {}");
    const dashboard = new Dashboard(dir);
    expect(dashboard.file("/")).toMatchObject({ type: "text/html; charset=utf-8" });
    expect(dashboard.file("/assets/index-abc.js")?.body.toString()).toBe("export {}");
    expect(dashboard.file("/assets/index-abc.js")?.type).toContain("text/javascript");
    expect(dashboard.file("/assets/other.js")).toBeNull();
    expect(dashboard.file("/../package.json")).toBeNull();
  });
});
