import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/server/config.ts";
import { resolveHome } from "../src/server/home.ts";
import { parsePipeline, type Pipeline } from "../src/pipeline/load.ts";
import { checkPath, doctor, homePipelines, missingFromPath, missingTools, neededTools, notOnPath, type Lookup, type NeededTool, type RunCommand, type TicketUse } from "../src/tools/tools.ts";
import type { ToolResult } from "../src/tracker/exec.ts";

// The tool check: which external tools a config needs and why, then PATH and login through injected lookups (LASSO-96).

const configOf = (yaml: string): Config => {
  const home = resolveHome({ LASSO_HOME: mkdtempSync(path.join(tmpdir(), "lasso-tools-")) });
  writeFileSync(home.configFile, yaml);
  return loadConfig(home);
};

const PROFILES = `
profiles:
  claude-opus: { runner: claude, model: opus }
  codex-high: { runner: codex, effort: high }
  pi-gpt: { runner: pi, model: openai/gpt-5 }
default_profile: claude-opus
notifications: { enabled: false }
`;

const WORK = parsePipeline("work", `stages:
  - name: implement
    prompt: Do the work.
    artifact: commits-on-branch
`);

const needs = (config: Config, pipelines: Pipeline[] = [WORK], tickets: TicketUse[] = []) => neededTools({ config, pipelines, tickets });
const names = (tools: NeededTool[]) => tools.map((t) => t.name);
const tool = (tools: NeededTool[], name: string) => tools.find((t) => t.name === name);
const lookupOf = (present: string[]): Lookup => (command) => (present.includes(command) ? `/bin/${command}` : null);

describe("the tools a config needs", () => {
  it("always needs git, and the Runner of default_profile, but no Runner nothing uses", () => {
    const tools = needs(configOf(PROFILES));
    expect(names(tools)).toEqual(["git", "claude"]);
    expect(tool(tools, "claude")!.reasons).toEqual(["profile claude-opus (default_profile)"]);
    expect(tool(tools, "codex")).toBeUndefined();
    expect(tool(tools, "pi")).toBeUndefined();
  });

  it("needs the Runner a Pipeline, a Stage, a repo's default or a Ticket's override names", () => {
    const config = configOf(PROFILES + `
repos:
  app: { tracker: jira, project: APP, path: /src/app, default_profile: pi-gpt }
`);
    const piped = parsePipeline("fast", `profile: codex-high
stages:
  - name: plan
    prompt: Plan it.
`);
    const tools = needs(config, [piped], [{ name: "APP-1", repo: "app", overrides: { plan: "pi-gpt" } }]);
    expect(tool(tools, "codex")!.reasons).toEqual(["profile codex-high (Pipeline fast)"]);
    expect(tool(tools, "pi")!.reasons).toEqual(["profile pi-gpt (repo app's default_profile)", "profile pi-gpt (Ticket APP-1's override)"]);
  });

  it("follows a repo's own profile of the same name to its Runner", () => {
    const config = configOf(PROFILES + `
repos:
  app:
    tracker: jira
    project: APP
    path: /src/app
    profiles:
      claude-opus: { runner: codex }
`);
    expect(tool(needs(config), "codex")!.reasons).toEqual(["profile claude-opus (default_profile)"]);
  });

  it("needs gh for a GitHub tracker repo and acli for a JIRA one", () => {
    const config = configOf(PROFILES + `
repos:
  web: { tracker: github, project: me/web, path: /src/web }
  api: { tracker: jira, project: API, path: /src/api }
`);
    const tools = needs(config);
    expect(tool(tools, "gh")!.reasons).toEqual(["repo web's tracker (github)"]);
    expect(tool(tools, "acli")!.reasons).toEqual(["repo api's tracker (jira)"]);
  });

  it("needs acli when an Action's run text names it, and not for a word that only contains it", () => {
    const config = configOf(PROFILES + `
actions:
  move-issue:
    run: acli jira workitem transition --key "$LASSO_TICKET" --status Done
  deploy:
    run: ./scripts/macli-deploy && echo gh-pages
`);
    const tools = needs(config);
    expect(tool(tools, "acli")!.reasons).toEqual(["Action move-issue"]);
    expect(tool(tools, "gh")).toBeUndefined();
  });

  it("needs gh when a Stage reads the PR", () => {
    const review = parsePipeline("review", `stages:
  - name: review
    prompt: Address the Feedback.
    repeat: feedback
    artifact: pr-merged
`);
    expect(tool(needs(configOf(PROFILES), [review]), "gh")!.reasons).toEqual(["Pipeline review reads the PR"]);
  });

  it("lists terminal-notifier as optional while notifications are on", () => {
    const tools = needs(configOf(PROFILES.replace("notifications: { enabled: false }", "")));
    expect(tool(tools, "terminal-notifier")!.optional).toBe(true);
  });

  it("reads the default Pipeline for a home with none yet", () => {
    const home = resolveHome({ LASSO_HOME: mkdtempSync(path.join(tmpdir(), "lasso-tools-")) });
    expect(homePipelines(home).map((p) => p.name)).toEqual(["default"]);
  });
});

describe("checking PATH", () => {
  it("finds present tools and reports missing needed ones, never an optional one", () => {
    const tools = needs(configOf(PROFILES.replace("notifications: { enabled: false }", "")));
    const lookup = lookupOf(["git"]);
    expect(checkPath(tools, lookup).map((t) => [t.name, t.path])).toEqual([
      ["git", "/bin/git"],
      ["claude", null],
      ["terminal-notifier", null],
    ]);
    expect(names(missingTools(tools, lookup))).toEqual(["claude"]);
  });

  it("calls a failed start a PATH miss only when it was ENOENT and PATH really lacks a bare command", () => {
    const lookup = lookupOf(["git"]);
    expect(missingFromPath("claude", "ENOENT", lookup)).toBe(true);
    // A missing working directory reports ENOENT too.
    expect(missingFromPath("git", "ENOENT", lookup)).toBe(false);
    expect(missingFromPath("claude", "EACCES", lookup)).toBe(false);
    expect(missingFromPath("claude", undefined, lookup)).toBe(false);
    expect(missingFromPath("/opt/bin/claude", "ENOENT", lookup)).toBe(false);
    expect(notOnPath("claude", "profile claude-opus")).toBe("claude not found on PATH (profile claude-opus); run lasso doctor");
  });
});

describe("doctor", () => {
  const result = (code: number, stdout = ""): ToolResult => ({ code, stdout, stderr: "" });

  it("asks each found tool with a status command whether it is logged in, and no other", async () => {
    const config = configOf(PROFILES + `
repos:
  web: { tracker: github, project: me/web, path: /src/web }
  api: { tracker: jira, project: API, path: /src/api, default_profile: codex-high }
`);
    const asked: string[] = [];
    const run: RunCommand = async (command, args) => {
      asked.push([command, ...args].join(" "));
      if (command === "gh") return result(1);
      if (command === "claude") return result(0, JSON.stringify({ loggedIn: true }));
      return result(0, "✓ Authenticated");
    };
    const rows = await doctor(needs(config), { lookup: lookupOf(["git", "claude", "gh", "acli"]), run });
    expect(rows.map((r) => [r.name, r.path !== null, r.loggedIn])).toEqual([
      ["git", true, null],
      ["claude", true, true],
      ["codex", false, null],
      ["gh", true, false],
      ["acli", true, true],
    ]);
    expect(asked.sort()).toEqual(["acli jira auth status", "claude auth status", "gh auth status"]);
  });

  it("takes claude's loggedIn over its exit code", async () => {
    const rows = await doctor(needs(configOf(PROFILES)), { lookup: lookupOf(["git", "claude"]), run: async () => result(0, JSON.stringify({ loggedIn: false })) });
    expect(rows.find((r) => r.name === "claude")!.loggedIn).toBe(false);
  });
});
