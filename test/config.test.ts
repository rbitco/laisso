import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, loadConfig, ConfigError, actionsFor, actionSets, profilesFor, resolveProfile, prListsBlock, prListsText, applyLive, reviewFor } from "../src/server/config.ts";
import { resolveHome } from "../src/server/home.ts";

const homeWith = (yaml: string) => {
  const home = resolveHome({ LAISSO_HOME: mkdtempSync(path.join(tmpdir(), "laisso-config-")) });
  writeFileSync(home.configFile, yaml);
  return home;
};

describe("the default config.yaml", () => {
  it("parses to exactly the built-in defaults, so the two cannot drift", () => {
    expect(parse(DEFAULT_CONFIG_YAML)).toEqual(DEFAULT_CONFIG);
  });

  it("ships the three Claude profiles in auto with effort unset, claude-opus the default", () => {
    const config = loadConfig(homeWith(DEFAULT_CONFIG_YAML));
    expect(config.profiles).toEqual({
      "claude-fable": { runner: "claude", model: "fable", permission: "auto" },
      "claude-opus": { runner: "claude", model: "opus", permission: "auto" },
      "claude-sonnet": { runner: "claude", model: "sonnet", permission: "auto" },
    });
    expect(config.default_profile).toBe("claude-opus");
    // The migration's runner-only names are left to it.
    for (const reserved of ["claude", "codex", "pi"]) expect(config.profiles[reserved]).toBeUndefined();
  });

  it("gives valid Codex and Pi profiles when their examples are uncommented", () => {
    const start = DEFAULT_CONFIG_YAML.indexOf("\nprofiles:\n");
    const end = DEFAULT_CONFIG_YAML.indexOf("\ndefault_profile:", start);
    const uncommented = DEFAULT_CONFIG_YAML.slice(0, start) + DEFAULT_CONFIG_YAML.slice(start, end).replace(/^#/gm, "") + DEFAULT_CONFIG_YAML.slice(end);
    const profiles = loadConfig(homeWith(uncommented)).profiles;
    expect(Object.keys(profiles)).toEqual(["claude-fable", "claude-opus", "claude-sonnet", "codex-high", "pi-gpt"]);
    expect(profiles["codex-high"]).toEqual({ runner: "codex", model: "gpt-5-codex", effort: "high", permission: "auto", human: { permission: "edits", args: ["--search"] } });
    expect(profiles["pi-gpt"]).toEqual({ runner: "pi", model: "openai/gpt-5", effort: "medium", human: { effort: "high" } });
  });
});

describe("loadConfig", () => {
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

  it("caps each Route at 3 by default, and reads budget.routes as a whole number", () => {
    expect(loadConfig(homeWith("")).budget.routes).toBe(3);
    expect(loadConfig(homeWith(DEFAULT_CONFIG_YAML)).budget.routes).toBe(3);
    expect(loadConfig(homeWith("budget: { routes: 0 }\n")).budget.routes).toBe(0);
    expect(() => loadConfig(homeWith("budget: { routes: 1.5 }\n"))).toThrow(/budget\.routes/);
  });

  it("reads Actions, with params and a timeout defaulting to 60s, and refuses a malformed one", () => {
    const yaml = (actions: string) => `actions:\n${actions}`;
    expect(loadConfig(homeWith(yaml("  notify:\n    params: [channel]\n    run: echo hi\n  slack.post:\n    timeout: 30s\n    run: ./post\n"))).actions).toEqual({
      notify: { run: "echo hi", params: ["channel"], timeout: "60s" },
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
    expect(config.repos.app!.actions).toEqual({ notify: { run: "local", params: ["channel"], timeout: "60s" }, deploy: { run: "./deploy", params: [], timeout: "60s" } });
    expect(config.repos.web!.actions).toEqual({});
    expect(actionsFor(config, "app")).toMatchObject({ notify: { run: "local" }, page: { run: "pager" }, deploy: { run: "./deploy" } });
    expect(actionsFor(config, "web")).toEqual(config.actions);
    expect(actionSets(config)).toEqual([config.actions, actionsFor(config, "app"), actionsFor(config, "web")]);
    expect(() => loadConfig(homeWith("repos:\n  app:\n    actions:\n      notify: {}\n"))).toThrow(/repos\.app\.actions\.notify: run must be a command/);
  });

  it("reads Agent Profiles and default_profile, defaulting to the shipped ones, and refuses a malformed one", () => {
    expect(loadConfig(homeWith(""))).toMatchObject({ profiles: DEFAULT_CONFIG.profiles, default_profile: "claude-opus" });
    expect(loadConfig(homeWith("profiles:\n  codex-fast: { runner: codex, model: gpt-5-codex, args: [-c, 1], skills_dir: /opt/skills }\ndefault_profile: codex-fast\n"))).toMatchObject({
      profiles: { "codex-fast": { runner: "codex", model: "gpt-5-codex", args: ["-c", "1"], skills_dir: "/opt/skills" } },
      default_profile: "codex-fast",
    });
    expect(loadConfig(homeWith("profiles:\n  deep: { runner: claude, effort: xhigh, permission: full }\n")).profiles.deep).toEqual({ runner: "claude", effort: "xhigh", permission: "full" });
    expect(loadConfig(homeWith("profiles:\n  split: { runner: claude, args: [-a], human: { permission: auto, args: [-b] }, headless: { model: opus } }\n")).profiles.split).toEqual({
      runner: "claude",
      args: ["-a"],
      human: { permission: "auto", args: ["-b"] },
      headless: { model: "opus" },
    });
    expect(loadConfig(homeWith("default_profile: null\n")).default_profile).toBeNull();
    const bad = (yaml: string) => () => loadConfig(homeWith(`profiles:\n${yaml}`));
    expect(bad("  fast: { model: x }\n")).toThrow(/profiles\.fast: runner must be one of claude, codex, pi, not unset/);
    expect(bad("  fast: { runner: gemini }\n")).toThrow(/runner must be one of claude, codex, pi, not gemini/);
    expect(bad("  Fast: { runner: pi }\n")).toThrow(/profiles\.Fast: a profile name is lowercase/);
    expect(bad("  fast: { runner: pi, model: \"\" }\n")).toThrow(/profiles\.fast\.model must be a model name/);
    expect(bad("  fast: { runner: pi, args: --verbose }\n")).toThrow(/profiles\.fast\.args must be a list of arguments/);
    expect(bad("  fast: { runner: codex, skills_dir: 3 }\n")).toThrow(/profiles\.fast\.skills_dir must be a directory/);
    expect(bad("  fast: { runner: claude, effort: extreme }\n")).toThrow(/profiles\.fast\.effort must be one of low, medium, high, xhigh, max, not extreme/);
    expect(bad("  fast: { runner: codex, permission: yolo }\n")).toThrow(/profiles\.fast\.permission must be one of auto, edits, full, not yolo/);
    expect(bad("  fast: { runner: pi, permission: true }\n")).toThrow(/profiles\.fast\.permission must be one of auto, edits, full, not true/);
    expect(bad("  fast: { runner: claude, reasoning: high }\n")).toThrow(/profiles\.fast: unknown field reasoning/);
    expect(bad("  fast: { runner: claude, human: { runner: pi } }\n")).toThrow(/profiles\.fast\.human: unknown field runner/);
    expect(bad("  fast: { runner: codex, headless: { skills_dir: /opt } }\n")).toThrow(/profiles\.fast\.headless: unknown field skills_dir/);
    expect(bad("  fast: { runner: claude, human: { permission: yolo } }\n")).toThrow(/profiles\.fast\.human\.permission must be one of auto, edits, full, not yolo/);
    expect(bad("  fast: { runner: claude, headless: { effort: extreme } }\n")).toThrow(/profiles\.fast\.headless\.effort must be one of low, medium, high, xhigh, max, not extreme/);
    expect(bad("  fast: { runner: claude, human: { model: \"\" } }\n")).toThrow(/profiles\.fast\.human\.model must be a model name/);
    expect(bad("  fast: { runner: claude, human: { args: --verbose } }\n")).toThrow(/profiles\.fast\.human\.args must be a list of arguments/);
    expect(bad("  fast: { runner: claude, human: auto }\n")).toThrow(/profiles\.fast\.human must be a mapping, not auto/);
    expect(() => loadConfig(homeWith("default_profile: Big\n"))).toThrow(/default_profile: a profile name is lowercase/);
  });

  it("reads a repo's own Agent Profiles and default_profile, checked as the global ones are", () => {
    const config = loadConfig(homeWith("profiles:\n  claude-opus: { runner: claude, model: opus, args: [-v] }\nrepos:\n  app:\n    default_profile: solo\n    profiles:\n      claude-opus: { runner: claude, model: sonnet, human: { permission: auto } }\n      solo: { runner: pi }\n  web: {}\n"));
    expect(config.repos.app).toMatchObject({ default_profile: "solo", profiles: { "claude-opus": { runner: "claude", model: "sonnet", human: { permission: "auto" } }, solo: { runner: "pi" } } });
    expect(config.repos.web).toMatchObject({ default_profile: null, profiles: {} });
    // The repo's claude-opus replaces the global one whole: the global args do not come along.
    expect(profilesFor(config, "app")["claude-opus"]).toEqual({ runner: "claude", model: "sonnet", human: { permission: "auto" } });
    expect(profilesFor(config, "web")).toEqual(config.profiles);
    const bad = (yaml: string) => () => loadConfig(homeWith(`repos:\n  app:\n${yaml}`));
    expect(bad("    profiles:\n      fast: { runner: gemini }\n")).toThrow(/repos\.app\.profiles\.fast: runner must be one of claude, codex, pi, not gemini/);
    expect(bad("    profiles:\n      fast: { runner: claude, effort: extreme }\n")).toThrow(/repos\.app\.profiles\.fast\.effort must be one of/);
    expect(bad("    profiles:\n      fast: { runner: claude, human: { runner: pi } }\n")).toThrow(/repos\.app\.profiles\.fast\.human: unknown field runner/);
    expect(bad("    profiles: [fast]\n")).toThrow(/repos\.app\.profiles must be a mapping/);
    expect(bad("    default_profile: Big\n")).toThrow(/repos\.app\.default_profile: a profile name is lowercase/);
  });

  it("reads PR Lists in file order, defaulting to Mine and Review requested, and refuses a malformed one", () => {
    expect(loadConfig(homeWith("")).pr_lists).toEqual(DEFAULT_CONFIG.pr_lists);
    expect(Object.keys(loadConfig(homeWith(DEFAULT_CONFIG_YAML)).pr_lists)).toEqual(["Mine", "Review requested"]);
    const written = loadConfig(homeWith("pr_lists:\n  Zeta:\n    query: is:open org:example\n  Alpha:\n    query: is:open author:@me\n    limit: 100\n")).pr_lists;
    expect(Object.entries(written)).toEqual([
      ["Zeta", { query: "is:open org:example", limit: 25 }],
      ["Alpha", { query: "is:open author:@me", limit: 100 }],
    ]);
    expect(loadConfig(homeWith("pr_lists: {}\n")).pr_lists).toEqual({});
    const bad = (yaml: string) => () => loadConfig(homeWith(`pr_lists:\n  Mine:\n${yaml}`));
    expect(bad("    query: is:open\n    limit: 0\n")).toThrow(/pr_lists\.Mine\.limit must be a whole number of 1 or more/);
    expect(bad("    query: is:open\n    limit: 101\n")).toThrow(/pr_lists\.Mine\.limit must be 100 or less/);
    expect(bad("    query: is:open is:issue\n")).toThrow(/pr_lists\.Mine\.query asks for is:issue/);
    expect(bad("    query: ''\n")).toThrow(/pr_lists\.Mine\.query must be a GitHub search/);
    expect(bad("    query: is:open\n    sort: updated\n")).toThrow(/pr_lists\.Mine: unknown field sort/);
    expect(() => loadConfig(homeWith("pr_lists:\n  2024:\n    query: is:open\n"))).toThrow(/pr_lists\.2024: a PR List name needs a letter/);
  });

  it("reads a PR List's search: advanced, keeps legacy as the default, and refuses anything else (LASSO-161)", () => {
    const lists = loadConfig(homeWith("pr_lists:\n  Either:\n    query: author:@me OR assignee:@me\n    search: advanced\n  Plain:\n    query: is:open\n    search: legacy\n")).pr_lists;
    expect(lists).toEqual({ Either: { query: "author:@me OR assignee:@me", limit: 25, search: "advanced" }, Plain: { query: "is:open", limit: 25 } });
    expect(() => loadConfig(homeWith("pr_lists:\n  Mine:\n    query: is:open\n    search: fancy\n"))).toThrow(/pr_lists\.Mine\.search must be legacy or advanced/);
  });

  it("takes hide_when_empty on a PR List, keeping it only when true", () => {
    const lists = loadConfig(homeWith("pr_lists:\n  Train:\n    query: is:open label:train\n    hide_when_empty: true\n  Mine:\n    query: is:open author:@me\n    hide_when_empty: false\n")).pr_lists;
    expect(lists).toEqual({ Train: { query: "is:open label:train", limit: 25, hide_when_empty: true }, Mine: { query: "is:open author:@me", limit: 25 } });
    expect(() => loadConfig(homeWith("pr_lists:\n  Train:\n    query: is:open\n    hide_when_empty: maybe\n"))).toThrow(/pr_lists\.Train\.hide_when_empty must be true or false/);
  });

  it("writes the Config page's pr_lists: block in place, and reads it back with its comments", () => {
    const file = "/c/config.yaml";
    expect(parse(prListsBlock(DEFAULT_CONFIG_YAML))).toEqual(DEFAULT_CONFIG.pr_lists);
    expect(parse(prListsBlock("tick: 30\n"))).toEqual(DEFAULT_CONFIG.pr_lists);
    const edited = prListsText(DEFAULT_CONFIG_YAML, file, "# mine first\nOld:\n  query: is:closed author:@me # recent\n  limit: 5\n");
    expect(edited.config.pr_lists).toEqual({ Old: { query: "is:closed author:@me", limit: 5 } });
    expect(edited.config.tick).toBe(DEFAULT_CONFIG.tick);
    expect(edited.text).toContain("# recent");
    expect(edited.text).toContain("notifications:\n  enabled: true");
    expect(prListsBlock(edited.text)).toContain("query: is:closed author:@me # recent");
    const none = prListsText(edited.text, file, "");
    expect(none.config.pr_lists).toEqual({});
    expect(none.text).toContain("pr_lists: {}");
    expect(prListsBlock(none.text)).toBe("{}\n");
    expect(() => prListsText(DEFAULT_CONFIG_YAML, file, "Mine:\n  query: is:issue\n")).toThrow(/is:issue/);
    expect(() => prListsText(DEFAULT_CONFIG_YAML, file, "- Mine\n")).toThrow(/pr_lists must be a mapping/);
  });

  it("carries an edited pr_lists into the running config, in its new order", () => {
    const live = loadConfig(homeWith(""));
    applyLive(live, loadConfig(homeWith("pr_lists:\n  B:\n    query: is:open\n  A:\n    query: is:draft\n")));
    expect(Object.keys(live.pr_lists)).toEqual(["B", "A"]);
  });

  it("reads pr_list_refresh as a duration of at least the tick, defaulting to 5m or a longer tick", () => {
    expect(loadConfig(homeWith("")).pr_list_refresh).toBe("5m");
    expect(loadConfig(homeWith("tick: 30\npr_list_refresh: 90s\n")).pr_list_refresh).toBe("90s");
    expect(loadConfig(homeWith("tick: 60\npr_list_refresh: 1m\n")).pr_list_refresh).toBe("1m");
    // A long tick alone is never an error: left out, the refresh follows it.
    expect(loadConfig(homeWith("tick: 3600\n")).pr_list_refresh).toBe("3600s");
    expect(() => loadConfig(homeWith("tick: 60\npr_list_refresh: 30s\n"))).toThrow(/pr_list_refresh must be at least the tick \(60s\), not 30s/);
    expect(() => loadConfig(homeWith("pr_list_refresh: soon\n"))).toThrow(ConfigError);
    expect(() => loadConfig(homeWith("pr_list_refresh: 300\n"))).toThrow(/pr_list_refresh/);
  });

  it("carries an edited pr_list_refresh into the running config", () => {
    const live = loadConfig(homeWith(""));
    applyLive(live, loadConfig(homeWith("pr_list_refresh: 10m\n")));
    expect(live.pr_list_refresh).toBe("10m");
  });

  it("reads pr_page_layout as stacked or side-by-side, defaulting to stacked", () => {
    expect(loadConfig(homeWith("")).pr_page_layout).toBe("stacked");
    expect(loadConfig(homeWith("pr_page_layout:\n")).pr_page_layout).toBe("stacked");
    expect(loadConfig(homeWith("pr_page_layout: side-by-side\n")).pr_page_layout).toBe("side-by-side");
    expect(() => loadConfig(homeWith("pr_page_layout: columns\n"))).toThrow(/pr_page_layout must be one of stacked, side-by-side, not columns/);
    expect(() => loadConfig(homeWith("pr_page_layout: Stacked\n"))).toThrow(ConfigError);
    expect(() => loadConfig(homeWith("pr_page_layout: true\n"))).toThrow(/pr_page_layout/);
  });

  it("carries an edited pr_page_layout into the running config", () => {
    const live = loadConfig(homeWith(""));
    applyLive(live, loadConfig(homeWith("pr_page_layout: side-by-side\n")));
    expect(live.pr_page_layout).toBe("side-by-side");
    applyLive(live, loadConfig(homeWith("")));
    expect(live.pr_page_layout).toBe("stacked");
  });
});

describe("resolveProfile", () => {
  const config = { profiles: { claude: { runner: "claude" as const }, fast: { runner: "pi" as const, model: "m" } }, default_profile: "claude", repos: {} };
  const pipeline = (profile: string | null) => ({ name: "p", profile });
  const stage = (profile: string | null) => ({ name: "s", profile, human: false });

  it("takes the Stage's profile, else the Pipeline's, else default_profile, saying which", () => {
    expect(resolveProfile(config, "app", pipeline("claude"), stage("fast"))).toEqual({ name: "fast", from: "stage", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(config, "app", pipeline("fast"), stage(null))).toEqual({ name: "fast", from: "pipeline", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(config, "app", pipeline(null), stage(null))).toEqual({ name: "claude", from: "default", profile: { runner: "claude" } });
  });

  it("merges the block for the Stage's mode: its fields replace the shared ones and its args follow", () => {
    const split = { runner: "claude" as const, model: "opus", effort: "high" as const, args: ["-a"], human: { permission: "auto" as const, args: ["-b", "-c"] }, headless: { model: "sonnet" } };
    const both = { ...config, profiles: { split } };
    expect(resolveProfile(both, "app", pipeline("split"), { ...stage(null), human: true })).toMatchObject({ profile: { runner: "claude", model: "opus", effort: "high", permission: "auto", args: ["-a", "-b", "-c"] } });
    expect(resolveProfile(both, "app", pipeline("split"), stage(null))).toEqual({ name: "split", from: "pipeline", profile: { runner: "claude", model: "sonnet", effort: "high", args: ["-a"] } });
  });

  it("names a missing profile and where it was named, and never falls back", () => {
    expect(resolveProfile(config, "app", pipeline("fast"), stage("gone"))).toEqual({ problem: "no profile named gone in config.yaml, which Stage s names" });
    expect(resolveProfile(config, "app", pipeline("gone"), stage(null))).toEqual({ problem: "no profile named gone in config.yaml, which Pipeline p names" });
    expect(resolveProfile({ ...config, default_profile: "gone" }, "app", pipeline(null), stage(null))).toEqual({ problem: "no profile named gone in config.yaml, which default_profile names" });
    expect(resolveProfile({ ...config, default_profile: null }, "app", pipeline(null), stage(null))).toEqual({ problem: "Stage s names no profile, nor does Pipeline p, and config.yaml has no default_profile" });
    expect(resolveProfile({ ...config, repos: { app: { profiles: {}, default_profile: "gone" } } }, "app", pipeline(null), stage(null))).toEqual({ problem: "no profile named gone in config.yaml, which repo app's default_profile names" });
  });

  it("takes a Ticket's override ahead of everything, and names it when its profile is missing", () => {
    expect(resolveProfile(config, "app", pipeline("claude"), stage("claude"), "fast")).toEqual({ name: "fast", from: "override", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(config, "app", pipeline(null), stage(null), null)).toMatchObject({ name: "claude", from: "default" });
    expect(resolveProfile(config, "app", pipeline("fast"), stage("fast"), "gone")).toEqual({ problem: "no profile named gone in config.yaml, which the Ticket's override for Stage s names" });
  });

  it("takes the repo's default_profile ahead of config's, and the repo's own profile of a name over the global one", () => {
    const repos = { app: { profiles: { fast: { runner: "codex" as const }, solo: { runner: "claude" as const, model: "x" } }, default_profile: "solo" }, web: { profiles: {}, default_profile: null } };
    const scoped = { ...config, repos };
    expect(resolveProfile(scoped, "app", pipeline(null), stage(null))).toEqual({ name: "solo", from: "repo", profile: { runner: "claude", model: "x" } });
    expect(resolveProfile(scoped, "app", pipeline("fast"), stage(null))).toEqual({ name: "fast", from: "pipeline", profile: { runner: "codex" } });
    expect(resolveProfile(scoped, "web", pipeline(null), stage(null))).toEqual({ name: "claude", from: "default", profile: { runner: "claude" } });
    expect(resolveProfile(scoped, "web", pipeline("fast"), stage(null))).toEqual({ name: "fast", from: "pipeline", profile: { runner: "pi", model: "m" } });
    expect(resolveProfile(scoped, "web", pipeline("solo"), stage(null))).toEqual({ problem: "no profile named solo in config.yaml, which Pipeline p names" });
  });
});

describe("review", () => {
  it("ignores no one by default", () => {
    expect(loadConfig(homeWith("tick: 60\n")).review).toEqual({ ignore_authors: [], ignore_self: false });
  });

  it("takes logins and ignore_self globally, and a repo's own keys win for that repo alone", () => {
    const config = loadConfig(homeWith(`review:
  ignore_authors: [octocat, " hubot "]
  ignore_self: true
repos:
  web:
    project: WEB
    path: /tmp/web
    review:
      ignore_self: false
  api:
    project: API
    path: /tmp/api
    review:
      ignore_authors: [dependabot]
  docs:
    project: DOCS
    path: /tmp/docs
`));
    expect(config.review).toEqual({ ignore_authors: ["octocat", "hubot"], ignore_self: true });
    expect(config.repos.web!.review).toEqual({ ignore_self: false });
    expect(config.repos.docs!.review).toBeUndefined();
    expect(reviewFor(config, "web")).toEqual({ ignore_authors: ["octocat", "hubot"], ignore_self: false });
    expect(reviewFor(config, "api")).toEqual({ ignore_authors: ["dependabot"], ignore_self: true });
    expect(reviewFor(config, "docs")).toEqual(config.review);
  });

  it("refuses a login that is not text, a non-boolean ignore_self, and unknown keys", () => {
    expect(() => loadConfig(homeWith("review:\n  ignore_authors: octocat\n"))).toThrow(/review.ignore_authors must be a list of GitHub logins/);
    expect(() => loadConfig(homeWith("review:\n  ignore_authors: [1]\n"))).toThrow(/review.ignore_authors must be a list of GitHub logins/);
    expect(() => loadConfig(homeWith("review:\n  ignore_self: yes please\n"))).toThrow(/review.ignore_self must be true or false/);
    expect(() => loadConfig(homeWith("review:\n  ignore: [a]\n"))).toThrow(/review: unknown field ignore/);
    expect(() => loadConfig(homeWith("repos:\n  web:\n    project: W\n    path: /tmp/w\n    review:\n      ignore_authors: [2]\n"))).toThrow(/repos.web.review.ignore_authors must be a list/);
  });

  it("applies live", () => {
    const live = structuredClone(DEFAULT_CONFIG);
    applyLive(live, loadConfig(homeWith("review:\n  ignore_authors: [octocat]\n")));
    expect(live.review.ignore_authors).toEqual(["octocat"]);
  });
});
