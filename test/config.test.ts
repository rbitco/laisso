import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, loadConfig, ConfigError, actionsFor, actionSets, resolveProfile } from "../src/server/config.ts";
import { resolveHome } from "../src/server/home.ts";

describe("the default config.yaml", () => {
  it("parses to exactly the built-in defaults, so the two cannot drift", () => {
    expect(parse(DEFAULT_CONFIG_YAML)).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig", () => {
  const homeWith = (yaml: string) => {
    const home = resolveHome({ LASSO_HOME: mkdtempSync(path.join(tmpdir(), "lasso-config-")) });
    writeFileSync(home.configFile, yaml);
    return home;
  };

  it("refuses a concurrency that is zero, negative, or fractional", () => {
    for (const bad of ["0", "-1", "1.5"]) {
      expect(() => loadConfig(homeWith(`concurrency: ${bad}\n`))).toThrow(ConfigError);
      expect(() => loadConfig(homeWith(`concurrency: ${bad}\n`))).toThrow(/concurrency must be a whole number of 1 or more/);
    }
    expect(loadConfig(homeWith("concurrency: 4\n")).concurrency).toBe(4);
    expect(() => loadConfig(homeWith("concurrency: many\n"))).toThrow(/concurrency must be a whole number of 1 or more, not many/);
    expect(() => loadConfig(homeWith("budget: 5\n"))).toThrow(/budget must be a mapping, not 5/);
    expect(() => loadConfig(homeWith("budget: { wallTime: 30 }\n"))).toThrow(/budget\.wallTime/);
    expect(loadConfig(homeWith("")).concurrency).toBe(3);
  });

  it("reads Actions, with params and a timeout defaulting to 5m, and refuses a malformed one", () => {
    const yaml = (actions: string) => `actions:\n${actions}`;
    expect(loadConfig(homeWith(yaml("  notify:\n    params: [channel]\n    run: echo hi\n  slack.post:\n    timeout: 30s\n    run: ./post\n"))).actions).toEqual({
      notify: { run: "echo hi", params: ["channel"], timeout: "5m" },
      "slack.post": { run: "./post", params: [], timeout: "30s" },
    });
    expect(() => loadConfig(homeWith(yaml("  notify: {}\n")))).toThrow(/actions\.notify: run must be a command/);
    expect(() => loadConfig(homeWith(yaml("  Notify:\n    run: x\n")))).toThrow(/actions\.Notify: an Action name is lowercase/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    params: [Channel]\n")))).toThrow(/actions\.notify: params must be a list of names/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    params: [a, a]\n")))).toThrow(/params names one param twice/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    timeout: soon\n")))).toThrow(/actions\.notify\.timeout/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    command: y\n")))).toThrow(/actions\.notify: unknown field command/);
  });

  it("reads a repo's own Actions, which replace global ones of the same name for that repo", () => {
    const config = loadConfig(homeWith("actions:\n  notify:\n    run: global\n  page:\n    run: pager\nrepos:\n  app:\n    actions:\n      notify:\n        run: local\n        params: [channel]\n      deploy:\n        run: ./deploy\n  web: {}\n"));
    expect(config.repos.app!.actions).toEqual({ notify: { run: "local", params: ["channel"], timeout: "5m" }, deploy: { run: "./deploy", params: [], timeout: "5m" } });
    expect(config.repos.web!.actions).toEqual({});
    expect(actionsFor(config, "app")).toMatchObject({ notify: { run: "local" }, page: { run: "pager" }, deploy: { run: "./deploy" } });
    expect(actionsFor(config, "web")).toEqual(config.actions);
    expect(actionSets(config)).toEqual([config.actions, actionsFor(config, "app"), actionsFor(config, "web")]);
    expect(() => loadConfig(homeWith("repos:\n  app:\n    actions:\n      notify: {}\n"))).toThrow(/repos\.app\.actions\.notify: run must be a command/);
  });

  it("reads Agent Profiles and default_profile, defaulting to a runner-only claude, and refuses a malformed one", () => {
    expect(loadConfig(homeWith(""))).toMatchObject({ profiles: { claude: { runner: "claude" } }, default_profile: "claude" });
    expect(loadConfig(homeWith("profiles:\n  codex-fast: { runner: codex, model: gpt-5-codex, args: [-c, 1], skills_dir: /opt/skills }\ndefault_profile: codex-fast\n"))).toMatchObject({
      profiles: { "codex-fast": { runner: "codex", model: "gpt-5-codex", args: ["-c", "1"], skills_dir: "/opt/skills" } },
      default_profile: "codex-fast",
    });
    expect(loadConfig(homeWith("default_profile: null\n")).default_profile).toBeNull();
    const bad = (yaml: string) => () => loadConfig(homeWith(`profiles:\n${yaml}`));
    expect(bad("  fast: { model: x }\n")).toThrow(/profiles\.fast: runner must be one of claude, codex, pi, not unset/);
    expect(bad("  fast: { runner: gemini }\n")).toThrow(/runner must be one of claude, codex, pi, not gemini/);
    expect(bad("  Fast: { runner: pi }\n")).toThrow(/profiles\.Fast: a profile name is lowercase/);
    expect(bad("  fast: { runner: pi, model: \"\" }\n")).toThrow(/profiles\.fast\.model must be a model name/);
    expect(bad("  fast: { runner: pi, args: --verbose }\n")).toThrow(/profiles\.fast\.args must be a list of arguments/);
    expect(bad("  fast: { runner: codex, skills_dir: 3 }\n")).toThrow(/profiles\.fast\.skills_dir must be a directory/);
    expect(bad("  fast: { runner: claude, effort: high }\n")).toThrow(/profiles\.fast: unknown field effort/);
    expect(() => loadConfig(homeWith("default_profile: Big\n"))).toThrow(/default_profile: a profile name is lowercase/);
  });
});

describe("resolveProfile", () => {
  const config = { profiles: { claude: { runner: "claude" as const }, fast: { runner: "pi" as const, model: "m" } }, default_profile: "claude" };
  const pipeline = (profile: string | null) => ({ name: "p", profile });
  const stage = (profile: string | null) => ({ name: "s", profile });

  it("takes the Stage's profile, else the Pipeline's, else default_profile, saying which", () => {
    expect(resolveProfile(config, pipeline("claude"), stage("fast"))).toEqual({ name: "fast", from: "stage", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(config, pipeline("fast"), stage(null))).toEqual({ name: "fast", from: "pipeline", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(config, pipeline(null), stage(null))).toEqual({ name: "claude", from: "default", profile: { runner: "claude" } });
  });

  it("names a missing profile and where it was named, and never falls back", () => {
    expect(resolveProfile(config, pipeline("fast"), stage("gone"))).toEqual({ problem: "no profile named gone in config.yaml, which Stage s names" });
    expect(resolveProfile(config, pipeline("gone"), stage(null))).toEqual({ problem: "no profile named gone in config.yaml, which Pipeline p names" });
    expect(resolveProfile({ ...config, default_profile: "gone" }, pipeline(null), stage(null))).toEqual({ problem: "no profile named gone in config.yaml, which default_profile names" });
    expect(resolveProfile({ ...config, default_profile: null }, pipeline(null), stage(null))).toEqual({ problem: "Stage s names no profile, nor does Pipeline p, and config.yaml has no default_profile" });
  });
});
