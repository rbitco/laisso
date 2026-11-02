import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeHome, runCli, runnerShim, writeConfig } from "./harness.ts";
import { claudeAdapter } from "../src/runner/claude.ts";
import { codexAdapter } from "../src/runner/codex.ts";
import { piAdapter } from "../src/runner/pi.ts";
import { DEFAULT_PIPELINE_YAML } from "../src/pipeline/default.ts";
import { findPackageRoot } from "../src/package-root.ts";

// `laisso setup` runs the default profile's Runner in this terminal, in the Laisso home, on the setup prompt.

async function setupHome() {
  const { home, pathDir } = await makeHome();
  const userHome = mkdtempSync(path.join(tmpdir(), "laisso-user-"));
  const setup = (...args: string[]) => runCli(["setup", ...args], { home, pathDir, port: 0, env: { HOME: userHome } });
  return { home, pathDir, userHome, setup, runner: runnerShim(pathDir) };
}

describe("laisso setup", () => {
  it("makes a fresh home, installs the skill, and runs default_profile's Runner in the home on the setup prompt", async () => {
    const { home, userHome, setup, runner } = await setupHome();
    await rm(path.join(home, "config.yaml"));
    const result = await setup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`setting up ${home} with claude (profile claude-opus)`);

    expect(readFileSync(path.join(home, "pipelines", "default.yaml"), "utf8")).toBe(DEFAULT_PIPELINE_YAML);
    expect(existsSync(path.join(userHome, ".claude", "skills", "laisso", "SKILL.md"))).toBe(true);

    const [call, ...more] = await runner.calls();
    expect(more).toEqual([]);
    expect(call!.cwd).toBe(realpathSync(home));
    expect(call!.argv.slice(0, 5)).toEqual(["claude", "--permission-mode", "auto", "--model", "opus"]);
    const prompt = call!.argv.at(-1)!;
    expect(prompt).toContain(`Laisso's home is ${home}`);
    expect(prompt).toContain(path.join(findPackageRoot().skillDir, "SKILL.md"));
    expect(prompt).toContain("http://localhost:7433");
  });

  it("runs under the profile --profile names, as its human Sessions would", async () => {
    const { home, setup, runner } = await setupHome();
    await writeConfig(home, { profiles: { "codex-high": { runner: "codex", model: "gpt-6", effort: "high", human: { permission: "auto" } } }, default_profile: "codex-high" });
    expect((await setup("--profile", "codex-high")).code).toBe(0);
    const [call] = await runner.calls();
    expect(call!.argv.slice(0, -1)).toEqual(["codex", "--approve-for-me", "-c", "sandbox_workspace_write.network_access=true", "-m", "gpt-6", "-c", "model_reasoning_effort=high"]);
  });

  it("refuses a profile config.yaml lacks, naming those it has", async () => {
    const { setup, runner } = await setupHome();
    const result = await setup("--profile", "nobody");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no profile named nobody in config.yaml (profiles: claude-fable, claude-opus, claude-sonnet");
    expect(await runner.calls()).toEqual([]);
  });
});

describe("a Runner on a prompt alone", () => {
  it("is each Runner's interactive launch with the profile's flags and no Ticket", () => {
    expect(claudeAdapter.interactive("hi", { runner: "claude" }, "/h")).toEqual({ argv: ["claude", "--permission-mode", "acceptEdits", "hi"], cwd: "/h", env: {} });
    expect(codexAdapter.interactive("hi", { runner: "codex", permission: "full" }, "/h").argv).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "hi"]);
    expect(piAdapter.interactive("hi", { runner: "pi", model: "openai/gpt-5", effort: "low" }, "/h")).toEqual({ argv: ["pi", "-a", "--model", "openai/gpt-5", "--thinking", "low", "hi"], cwd: "/h", env: {} });
  });
});
