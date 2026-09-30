import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { startLasso, startLassoWithRepos, waitFor, type Lasso } from "./harness.ts";
import type { TicketDetail, IntakeResult } from "../src/api/views.ts";
import { migrateConfigText, migratePipelineText, JIRA_TRANSITION, GITHUB_TRANSITION } from "../src/server/migrate.ts";
import { parseConfig } from "../src/server/config.ts";
import { parsePipeline } from "../src/pipeline/load.ts";

// tracker.transition moves from Lasso's code into config (ADR 0010, LASSO-53).
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const OLD_PIPELINE = `# Keep this comment.
runner: claude
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
    expect(config.actions["tracker.transition"]).toEqual({ ...JIRA_TRANSITION, timeout: "5m" });
    expect(config.repos.web!.actions["tracker.transition"]).toEqual({ ...GITHUB_TRANSITION, timeout: "5m" });
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
    expect(again.stdout()).toMatch(/migrated\.actions config=true pipelines=flow versions=1/);

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
    expect(third.stdout()).not.toMatch(/migrated\.actions/);
  });
});

describe("tracker.transition on a GitHub repo", () => {
  const GH = `runner: claude
stages:
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
