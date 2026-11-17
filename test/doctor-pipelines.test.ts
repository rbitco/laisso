import { describe, it, expect, vi, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctor, renderDoctor } from "../src/cli/doctor.ts";

// laisso doctor's Pipelines section (LASSO-218): each Pipeline ok, kept as parts, or why it does not load; any broken one exits 1.
afterEach(() => vi.restoreAllMocks());

function laissoHome(pipelines: Record<string, string>) {
  const home = mkdtempSync(path.join(tmpdir(), "laisso-doctor-"));
  writeFileSync(path.join(home, "config.yaml"), "profiles: {}\ndefault_profile: null\nnotifications: { enabled: false }\npr_lists: {}\n");
  mkdirSync(path.join(home, "pipelines"));
  for (const [name, text] of Object.entries(pipelines)) writeFileSync(path.join(home, "pipelines", `${name}.yaml`), text);
  const bin = mkdtempSync(path.join(tmpdir(), "laisso-doctor-bin-"));
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "git"), 0o755);
  return { LAISSO_HOME: home, PATH: bin, HOME: mkdtempSync(path.join(tmpdir(), "laisso-doctor-user-")) };
}

async function run(env: Record<string, string>, json: boolean) {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  const code = await doctor({ json, env });
  vi.restoreAllMocks();
  return { code, out: lines.join("\n") };
}

const WORK = "stages:\n  - name: work\n    prompt: Work.\n";

describe("laisso doctor's Pipelines section", () => {
  it("lists each Pipeline, marks parts, and exits 0 when all load", async () => {
    const { code, out } = await run(laissoHome({ work: WORK, parts: "intake: false\n" + WORK }), false);
    expect(code).toBe(0);
    expect(out).toContain("pipelines:\n  parts  ok (parts)\n  work   ok\nevery Pipeline loads");
  });

  it("says why a Pipeline does not load and exits 1", async () => {
    const env = laissoHome({ work: WORK, "bug-fix": "stages:\n  - use: work.nope\n" });
    const { code, out } = await run(env, false);
    expect(code).toBe(1);
    expect(out).toContain("  bug-fix  does not load: Pipeline bug-fix stage 1 (use work.nope): work has no Stage named nope");
    expect(out).toContain("1 Pipeline does not load");
    const json = await run(env, true);
    expect(json.code).toBe(1);
    expect((JSON.parse(json.out) as { pipelines: unknown }).pipelines).toEqual([
      { name: "bug-fix", problem: "Pipeline bug-fix stage 1 (use work.nope): work has no Stage named nope", parts: false },
      { name: "work", problem: null, parts: false },
    ]);
  });

  it("renders nothing for a home with no Pipelines", () => {
    expect(renderDoctor("/h", [], [], [], "1.0.0", null, [])).not.toContain("pipelines:");
  });
});
