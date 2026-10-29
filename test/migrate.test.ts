import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { startLasso, startLassoWithRepos, waitFor, runnerFixture, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import { migrateConfigText, migratePipelineText, migrateConfigProfilesText, migratePipelineProfilesText, JIRA_TRANSITION, GITHUB_TRANSITION } from "../src/server/migrate.ts";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, parseConfig } from "../src/server/config.ts";
import { parsePipeline } from "../src/pipeline/load.ts";

// tracker.transition moves from Lasso's code into config (ADR 0010, LASSO-53).
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const OLD_PIPELINE = `# Keep this comment.
stages:
  - name: grill
    human: true
    prompt: Talk.
  - action: tracker.transition # move it
    status: In Progress
  - name: implement
    human: true
    prompt: Work.
  - action: tracker.transition
    status: Done
`;

const jiraView = (key: string, summary: string) => JSON.stringify({ key, fields: { summary, description: "Body." } });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);
const pull = (lasso: Lasso, id: string, trigger: string) => lasso.api<TicketDetail>(`/api/tickets/${id}/${trigger}`, { method: "POST", body: "{}" });
const checkNow = (lasso: Lasso) => lasso.api("/api/check-now", { method: "POST" });

describe("migrateConfigText", () => {
  const OLD = `# My config.
repos:
  app: { tracker: jira, project: APP, path: /a }
  web:
    tracker: github # the site
    project: acme/web
    path: /w
actions: {}
tick: 30 # fast
`;

  it("adds tracker.transition globally and a gh override per GitHub repo, keeping comments", () => {
    const text = migrateConfigText(OLD)!;
    expect(text).toContain("# My config.");
    expect(text).toContain("tracker: github # the site");
    expect(text).toContain("tick: 30 # fast");
    // The file pads its inline maps, so the migration keeps them padded and pads what it adds to match.
    expect(text).toContain("app: { tracker: jira, project: APP, path: /a }");
    expect(text).toContain("params: [ status ]");
    const config = parseConfig(text, "config.yaml");
    expect(config.actions["tracker.transition"]).toEqual({ ...JIRA_TRANSITION, timeout: "60s" });
    expect(config.repos.web!.actions["tracker.transition"]).toEqual({ ...GITHUB_TRANSITION, timeout: "60s" });
    expect(config.repos.app!.actions).toEqual({});
  });

  it("changes nothing the second time, or when tracker.transition is already defined", () => {
    expect(migrateConfigText(migrateConfigText(OLD)!)).toBeNull();
    expect(migrateConfigText("actions:\n  tracker.transition: { run: ./mine, params: [status] }\nrepos:\n  web: { tracker: github }\n")).toBeNull();
  });

  it("writes into a config that is empty", () => {
    expect(parseConfig(migrateConfigText("")!, "c").actions["tracker.transition"]!.params).toEqual(["status"]);
  });
});

describe("migratePipelineText", () => {
  it("moves status under with, keeping comments and names, and leaves a migrated file alone", () => {
    const text = migratePipelineText(OLD_PIPELINE)!;
    expect(text).toContain("# Keep this comment.");
    expect(text).toContain("  - action: tracker.transition # move it\n    with: {status: In Progress}\n");
    expect(parsePipeline("p", text).stages.map((s) => s.name)).toEqual(["grill", "transition-in-progress", "implement", "transition-done"]);
    expect(migratePipelineText(text)).toBeNull();
  });

  it("pads what it writes as the file pads its inline collections", () => {
    const padded = OLD_PIPELINE.replace("    prompt: Talk.\n", "    prompt: Talk.\n    budget: { attempts: 1 }\n");
    const text = migratePipelineText(padded)!;
    expect(text).toContain("    budget: { attempts: 1 }\n");
    expect(text).toContain("    with: { status: In Progress }\n");
  });
});

describe("the migration at startup", () => {
  it("rewrites config, Pipeline files and pinned Versions, so a live Ticket runs its next transition through config", async () => {
    const started = await startLassoWithRepos({ app: { tracker: "jira", project: "APP", pipeline: "flow" }, web: { tracker: "github", project: "acme/web" } });
    running.push(started.lasso);
    const { lasso } = started;
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "summary,description"], stdout: jiraView("APP-12", "Add dark mode") });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem view APP-12", "--fields labels"], stdout: JSON.stringify({ key: "APP-12", fields: { labels: [] } }) });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem edit"], stdout: "✓ ok\n" });
    await lasso.tracker.reply({ tool: "acli", match: ["workitem transition"], stdout: "✓ ok\n" });
    const pipelineFile = path.join(lasso.home, "pipelines", "flow.yaml");
    await writeFile(pipelineFile, migratePipelineText(OLD_PIPELINE)!);
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "APP-12" }) });
    expect(await lasso.stop()).toBe(0);

    // Put the home back as a Lasso from before ADR 0010 left it: no tracker.transition in config, status on the Stages.
    const configFile = path.join(lasso.home, "config.yaml");
    const config = parse(await readFile(configFile, "utf8"));
    delete config.actions;
    for (const repo of Object.values(config.repos) as Array<{ actions?: unknown }>) delete repo.actions;
    await writeFile(configFile, "# Hand-written.\n" + JSON.stringify(config, null, 2) + "\n");
    await writeFile(pipelineFile, OLD_PIPELINE);
    const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
    for (const row of db.prepare("SELECT pipeline, version, definition FROM pipeline_versions").all() as Array<{ pipeline: string; version: number; definition: string }>) {
      const definition = JSON.parse(row.definition);
      definition.stages = definition.stages.map((s: { kind: string; name: string; action: string; with?: { status: string } }) => (s.kind === "action" ? { kind: "action", name: s.name, action: s.action, status: s.with!.status } : s));
      db.prepare("UPDATE pipeline_versions SET definition = ? WHERE pipeline = ? AND version = ?").run(JSON.stringify(definition), row.pipeline, row.version);
    }
    db.close();

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    const migratedConfig = await readFile(configFile, "utf8");
    expect(migratedConfig).toContain("# Hand-written.");
    const parsed = parseConfig(migratedConfig, configFile);
    expect(parsed.actions["tracker.transition"]!.run).toBe(JIRA_TRANSITION.run);
    expect(parsed.repos.web!.actions["tracker.transition"]!.run).toBe(GITHUB_TRANSITION.run);
    expect(await readFile(pipelineFile, "utf8")).toBe(migratePipelineText(OLD_PIPELINE));
    expect(again.stdout()).toMatch(/migrated config=true pipelines=flow versions=1/);

    const detail = await detailOf(again, ticket.id);
    expect(detail.pipelineDrift).toBe("same");
    expect(detail.stage.name).toBe("grill");
    await again.tracker.clearCalls();
    await pull(again, ticket.id, "skip");
    await checkNow(again);
    const moved = await waitFor(async () => { const d = await detailOf(again, ticket.id); return d.stage.name === "implement" ? d : null; }, "the transition to run");
    expect(moved.sessions[0]).toMatchObject({ stage: "transition-in-progress", outcome: "succeeded", finalMessage: "moved APP-12 to In Progress" });
    expect((await again.tracker.calls()).map((c) => c.args.join(" "))).toContain("jira workitem transition --key APP-12 --status In Progress --yes");

    // A second start finds nothing to do.
    expect(await again.stop()).toBe(0);
    const pipelineText = await readFile(pipelineFile, "utf8");
    const third = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(third);
    expect(await readFile(configFile, "utf8")).toBe(migratedConfig);
    expect(await readFile(pipelineFile, "utf8")).toBe(pipelineText);
    expect(third.stdout()).not.toMatch(/migrated config=/);
  });
});

// runner: and runnerOptions become Agent Profiles in config (ADR 0011, LASSO-66).
const RUNNER_PIPELINE = `# Keep me.
runner: codex # the team's Runner
stages:
  - name: grill
    human: true
    prompt: Talk.
    runner: claude # the human's
  - name: implement
    prompt: Work.
    runnerOptions: { args: [ --verbose ], skillsDir: /opt/skills }
  - name: notes
    prompt: Notes.
    runner: pi
    runnerOptions: {}
`;

describe("migratePipelineProfilesText", () => {
  it("turns runner: into profile: and a Stage's runnerOptions into a <pipeline>-<stage> profile, keeping comments", () => {
    const { text, profiles } = migratePipelineProfilesText("release", RUNNER_PIPELINE)!;
    expect(text).toContain("# Keep me.\nprofile: codex # the team's Runner\n");
    expect(text).toContain("    profile: claude # the human's\n");
    expect(text).toContain("    prompt: Work.\n    profile: release-implement\n");
    expect(text).toContain("    prompt: Notes.\n    profile: pi\n");
    expect(text).not.toMatch(/runner|runnerOptions|skillsDir/);
    const pipeline = parsePipeline("release", text);
    expect(pipeline.profile).toBe("codex");
    expect(pipeline.stages.map((s) => (s.kind === "runner" ? s.profile : null))).toEqual(["claude", "release-implement", "pi"]);
    expect(profiles).toEqual({
      codex: { runner: "codex" },
      claude: { runner: "claude" },
      pi: { runner: "pi" },
      // The Stage inherited codex, so its own profile runs codex with its options.
      "release-implement": { runner: "codex", args: ["--verbose"], skills_dir: "/opt/skills" },
    });
  });

  it("changes nothing the second time, or in a Pipeline with no runner", () => {
    expect(migratePipelineProfilesText("release", migratePipelineProfilesText("release", RUNNER_PIPELINE)!.text)).toBeNull();
    expect(migratePipelineProfilesText("p", "stages:\n  - name: x\n    prompt: p\n")).toBeNull();
  });

  it("leaves a Pipeline naming a Runner Lasso does not have for its refusal to explain", () => {
    expect(() => migratePipelineProfilesText("p", "runner: gemini\nstages:\n  - name: x\n    prompt: p\n")).toThrow(/gemini/);
  });
});

describe("migrateConfigProfilesText", () => {
  const CONFIG = `# My config.
repos:
  app: { tracker: jira, project: APP, path: /a }
profiles:
  codex: { runner: codex, args: [ --mine ] } # hand-made
tick: 30 # fast
`;
  const named = migratePipelineProfilesText("release", RUNNER_PIPELINE)!.profiles;

  it("adds a runner-only profile per Runner in use and each Stage's own, without touching one already there", () => {
    const text = migrateConfigProfilesText(CONFIG, named)!;
    expect(text).toContain("# My config.");
    expect(text).toContain("tick: 30 # fast");
    expect(text).toContain("  codex: { runner: codex, args: [ --mine ] } # hand-made\n");
    // The file pads its inline collections, so the args written match.
    expect(text).toContain("    args: [ --verbose ]\n");
    const config = parseConfig(text, "config.yaml");
    expect(config.profiles).toEqual({
      codex: { runner: "codex", args: ["--mine"] },
      claude: { runner: "claude" },
      pi: { runner: "pi" },
      "release-implement": { runner: "codex", args: ["--verbose"], skills_dir: "/opt/skills" },
    });
    expect(config.default_profile).toBe("claude");
  });

  it("gives a config with neither key the claude profile and default_profile, and changes nothing the second time", () => {
    const text = migrateConfigProfilesText("tick: 30 # fast\n", {})!;
    expect(text).toBe("tick: 30 # fast\nprofiles:\n  claude:\n    runner: claude\ndefault_profile: claude\n");
    expect(migrateConfigProfilesText(text, {})).toBeNull();
    expect(migrateConfigProfilesText(migrateConfigProfilesText(CONFIG, named)!, named)).toBeNull();
  });

  it("keeps a default_profile someone set, even to none", () => {
    expect(migrateConfigProfilesText("profiles:\n  mine: { runner: pi }\ndefault_profile: mine\n", {})).toBeNull();
    expect(migrateConfigProfilesText("profiles: {}\ndefault_profile: null\n", {})).toBeNull();
  });

  it("leaves the shipped config.yaml alone: no claude profile, and claude-opus stays the default", () => {
    expect(migrateConfigProfilesText(DEFAULT_CONFIG_YAML, {})).toBeNull();
  });

  it("keeps the shipped profiles a config without profiles: reads as, when it must write another", () => {
    // With default_profile set and no profiles: key, config reads as the built-in profiles; nothing to write keeps it so.
    expect(migrateConfigProfilesText("default_profile: claude-opus\n", {})).toBeNull();
    const config = parseConfig(migrateConfigProfilesText("default_profile: claude-opus\n", { codex: { runner: "codex" } })!, "config.yaml");
    expect(config.profiles).toEqual({ ...DEFAULT_CONFIG.profiles, codex: { runner: "codex" } });
    expect(config.default_profile).toBe("claude-opus");
  });
});

describe("the Agent Profile migration at startup", () => {
  const NEW_PIPELINE = `profile: codex
stages:
  - name: implement
    prompt: Work.
    skills: [implement]
    artifact: commits-on-branch
    profile: release-implement
  - name: notes
    prompt: Notes.
    artifact: file NOTES.md
`;
  const OLD = `# Before profiles.
runner: codex
stages:
  - name: implement
    prompt: Work.
    skills: [implement]
    artifact: commits-on-branch
    runnerOptions: { args: [--verbose], skillsDir: /opt/skills }
  - name: notes
    prompt: Notes.
    artifact: file NOTES.md
`;
  const profiles = { codex: { runner: "codex" as const }, "release-implement": { runner: "codex" as const, args: ["--verbose"], skills_dir: "/opt/skills" } };
  const script = { stdout: runnerFixture("codex", "success.jsonl"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], files: { "NOTES.md": "notes\n" } };
  const intake = (lasso: Lasso) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "release" }) });
  /** A launch with one Ticket's names taken out, so two Tickets' launches compare. */
  const shape = (argv: string[], t: IntakeResult) => argv.map((a) => a.replaceAll(t.worktree, "<worktree>").replaceAll(t.branch, "<branch>").replaceAll(t.id, "<id>"));

  it("rewrites config, Pipeline files and pinned Versions from runner:, and a live Ticket launches as it would have", async () => {
    const started = await startLassoWithRepos({ app: { pipeline: "release" } }, { profiles }, { release: NEW_PIPELINE });
    running.push(started.lasso);
    const { lasso } = started;
    const before = await intake(lasso);
    await lasso.runner.script(script);
    await checkNow(lasso);
    await waitFor(async () => ((await detailOf(lasso, before.id)).state === "done" ? true : null), "the first Ticket to be done");
    // The second Ticket waits, pinned to the same Version, for after the restart.
    const live = await intake(lasso);
    expect(live.pipelineVersion).toBe(before.pipelineVersion);
    expect(await lasso.stop()).toBe(0);

    // Put the home back as a Lasso from before ADR 0011 left it.
    const configFile = path.join(lasso.home, "config.yaml");
    const config = parse(await readFile(configFile, "utf8"));
    delete config.profiles;
    delete config.default_profile;
    await writeFile(configFile, "# Hand-written.\n" + JSON.stringify(config, null, 2) + "\n");
    const pipelineFile = path.join(lasso.home, "pipelines", "release.yaml");
    await writeFile(pipelineFile, OLD);
    const db = new DatabaseSync(path.join(lasso.home, "lasso.db"));
    const rows = db.prepare("SELECT pipeline, version, definition FROM pipeline_versions").all() as Array<{ pipeline: string; version: number; definition: string }>;
    for (const row of rows) {
      const { name, profile, budget, stages } = JSON.parse(row.definition);
      const runner = profile ?? "claude";
      const old = {
        name,
        runner,
        budget,
        stages: stages.map((s: Record<string, unknown>) => {
          if (s.kind !== "runner") return s;
          const { kind, name: stage, prompt, skills, profile: own, human, advance, artifact, repeat, budget: b } = s;
          const options = own === "release-implement" ? { args: ["--verbose"], skillsDir: "/opt/skills" } : {};
          return { kind, name: stage, prompt, skills, runner, human, advance, artifact, repeat, budget: b, runnerOptions: options, inheritsRunner: own === null };
        }),
      };
      db.prepare("UPDATE pipeline_versions SET definition = ? WHERE pipeline = ? AND version = ?").run(JSON.stringify(old), row.pipeline, row.version);
    }
    db.prepare("UPDATE sessions SET profile = NULL").run();
    db.close();

    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    expect(again.stdout()).toMatch(/migrated config=true pipelines=release versions=1/);
    const migratedConfig = await readFile(configFile, "utf8");
    expect(migratedConfig).toContain("# Hand-written.");
    const parsed = parseConfig(migratedConfig, configFile);
    expect(parsed.profiles).toEqual({ claude: { runner: "claude" }, codex: { runner: "codex" }, "release-implement": { runner: "codex", args: ["--verbose"], skills_dir: "/opt/skills" } });
    expect(parsed.default_profile).toBe("claude");
    const migratedPipeline = await readFile(pipelineFile, "utf8");
    expect(migratedPipeline).toContain("# Before profiles.\nprofile: codex\n");
    expect(parsePipeline("release", migratedPipeline)).toEqual(parsePipeline("release", NEW_PIPELINE));

    const detail = await detailOf(again, live.id);
    expect(detail.pipelineDrift).toBe("same");
    // A Session from before profiles has no profile record to show.
    expect((await detailOf(again, before.id)).sessions.every((s) => s.profile === null)).toBe(true);
    await checkNow(again);
    await waitFor(async () => ((await detailOf(again, live.id)).state === "done" ? true : null), "the live Ticket to be done");
    const calls = await again.runner.calls();
    expect(calls).toHaveLength(4);
    expect(shape(calls[2]!.argv, live)).toEqual(shape(calls[0]!.argv, before));
    expect(shape(calls[3]!.argv, live)).toEqual(shape(calls[1]!.argv, before));
    expect(calls[2]!.argv).toContain("--verbose");
    expect(calls[2]!.argv.at(-1)!.startsWith("[$implement](/opt/skills/implement/SKILL.md)")).toBe(true);

    // A second start finds nothing to do.
    expect(await again.stop()).toBe(0);
    const third = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(third);
    expect(await readFile(configFile, "utf8")).toBe(migratedConfig);
    expect(await readFile(pipelineFile, "utf8")).toBe(migratedPipeline);
    expect(third.stdout()).not.toMatch(/migrated config=/);
  });
});

describe("tracker.transition on a GitHub repo", () => {
  const GH = `stages:
  - name: implement
    human: true
    prompt: Work.
  - action: tracker.transition
    with: { status: Closed }
  - name: check
    human: true
    prompt: Look.
  - action: tracker.transition
    with: { status: open }
  - name: triage
    human: true
    prompt: Look again.
  - action: tracker.transition
    with: { status: Shipped }
  - name: last
    human: true
    prompt: End.
`;

  it("closes and reopens the issue through gh, and Flags a status GitHub does not have", async () => {
    const started = await startLassoWithRepos({ web: { tracker: "github", project: "acme/web", pipeline: "gh" } }, {}, { gh: GH });
    running.push(started.lasso);
    const { lasso } = started;
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "title,body"], stdout: JSON.stringify({ title: "Fix links", body: "" }) });
    await lasso.tracker.reply({ tool: "gh", match: ["issue view 7", "--json labels"], stdout: JSON.stringify({ labels: [] }) });
    await lasso.tracker.reply({ tool: "gh", match: ["issue"], stdout: "" });
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "acme/web#7" }) });
    const through = async (stage: string) => {
      await pull(lasso, ticket.id, "skip");
      await checkNow(lasso);
      return waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.stage.name === stage || d.flag ? d : null; }, `the Ticket to reach ${stage}`);
    };
    expect((await through("check")).sessions[0]).toMatchObject({ outcome: "succeeded", finalMessage: "moved acme/web#7 to Closed" });
    expect((await through("triage")).sessions[0]).toMatchObject({ outcome: "succeeded", finalMessage: "moved acme/web#7 to open" });
    const flagged = await through("last");
    expect(flagged.flag).toMatchObject({ reason: "outcome.failed", detail: "tracker.transition exited 1: GitHub accepts only open and closed, not Shipped" });
    const moves = (await lasso.tracker.calls()).map((c) => c.args.join(" ")).filter((a) => /^issue (close|reopen)/.test(a));
    expect(moves).toEqual(["issue close 7 --repo acme/web", "issue reopen 7 --repo acme/web"]);
  });
});
