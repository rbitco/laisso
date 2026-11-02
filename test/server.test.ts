import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { startLaisso, runCli, makeHome, freePort, type Laisso } from "./harness.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/server/config.ts";
import { DEFAULT_PIPELINE_YAML } from "../src/pipeline/default.ts";

const running: Laisso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

describe("the laisso process", () => {
  it("starts, answers health, and writes the default config and Pipeline once", async () => {
    const laisso = await startLaisso();
    running.push(laisso);

    const health = await laisso.api<{ ok: boolean; pid: number }>("/api/health");
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(laisso.child.pid);

    const pipeline = await readFile(path.join(laisso.home, "pipelines", "default.yaml"), "utf8");
    expect(pipeline).toContain("name: grill");
    expect(pipeline).toContain("action: tracker.transition");

    // A hand edit survives a restart: the default is written only when absent.
    await laisso.stop();
    await writeFile(path.join(laisso.home, "pipelines", "default.yaml"), pipeline + "\n# hand edit\n");
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    const after = await readFile(path.join(laisso.home, "pipelines", "default.yaml"), "utf8");
    expect(after).toContain("# hand edit");
  });

  it("reports a dev build's version with no notice, and never asks npm for the latest", async () => {
    const { home, pathDir } = await makeHome();
    const asked = path.join(pathDir, "npm-asked");
    await writeFile(path.join(pathDir, "npm"), `#!/bin/sh\necho "$@" >> '${asked}'\necho 9.9.9\n`, { mode: 0o755 });
    const laisso = await startLaisso({ home, pathDir });
    running.push(laisso);
    expect(await laisso.api("/api/version")).toEqual({ version: "0.0.0-dev", notice: { kind: "none" }, text: null });
    expect(existsSync(asked)).toBe(false);
  });

  it("writes a default config.yaml on first run when the home is empty", async () => {
    const { home, pathDir } = await makeHome();
    await rm(path.join(home, "config.yaml"));
    const laisso = await startLaisso({ home, pathDir });
    running.push(laisso);
    const config = await readFile(path.join(home, "config.yaml"), "utf8");
    expect(config).toContain("tick: 60");
    expect(config).toContain("concurrency: 3");
    expect(config).toContain("port: 7433");
    // The startup migration finds a default_profile, so the shipped profiles stand alone: no runner-only claude beside them.
    const parsed = parseConfig(config, "config.yaml");
    expect(parsed.profiles).toEqual(DEFAULT_CONFIG.profiles);
    expect(parsed.default_profile).toBe("claude-opus");
    expect(await readFile(path.join(home, "pipelines", "default.yaml"), "utf8")).toBe(DEFAULT_PIPELINE_YAML);

    // A restart changes neither file.
    await laisso.stop();
    const again = await startLaisso({ home, pathDir, port: laisso.port });
    running.push(again);
    expect(await readFile(path.join(home, "config.yaml"), "utf8")).toBe(config);
    expect(await readFile(path.join(home, "pipelines", "default.yaml"), "utf8")).toBe(DEFAULT_PIPELINE_YAML);
  });

  it("leaves an existing home's config.yaml and default Pipeline as they are", async () => {
    const { home, pathDir } = await makeHome();
    const migrated = await startLaisso({ home, pathDir });
    running.push(migrated);
    await migrated.stop();
    // A config.yaml without default_profile is from before Agent Profiles: the migration gave it the runner-only claude as default.
    expect(parseConfig(await readFile(path.join(home, "config.yaml"), "utf8"), "config.yaml")).toMatchObject({ profiles: { claude: { runner: "claude" } }, default_profile: "claude" });
    // An install from before the shipped profiles: its own profile and default, and a default Pipeline that names none.
    const configFile = path.join(home, "config.yaml");
    const config = (await readFile(configFile, "utf8")).replace(/^profiles:\n(?: .*\n)*/m, "profiles:\n  mine:\n    runner: claude # my own\n").replace("default_profile: claude", "default_profile: mine");
    const pipelineFile = path.join(home, "pipelines", "default.yaml");
    const pipeline = DEFAULT_PIPELINE_YAML.replace(/^ {4}profile: .*\n/gm, "") + "# hand edit\n";
    await writeFile(configFile, config);
    await writeFile(pipelineFile, pipeline);
    expect(parseConfig(config, "config.yaml")).toMatchObject({ profiles: { mine: { runner: "claude" } }, default_profile: "mine" });
    expect(Object.keys(parseConfig(config, "config.yaml").profiles)).toEqual(["mine"]);

    const laisso = await startLaisso({ home, pathDir, port: migrated.port });
    running.push(laisso);
    expect(await readFile(configFile, "utf8")).toBe(config);
    expect(await readFile(pipelineFile, "utf8")).toBe(pipeline);
  });

  it("refuses a second laisso with the running URL and pid", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    const second = await runCli([], laisso);
    expect(second.code).toBe(1);
    expect(second.stderr + second.stdout).toContain(
      `laisso already running at http://localhost:${laisso.port} (pid ${laisso.child.pid})`,
    );
  });

  it("releases the lock on Ctrl-C so the next start succeeds", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    const code = await laisso.stop();
    expect(code).toBe(0);
    const again = await startLaisso({ home: laisso.home, pathDir: laisso.pathDir, port: laisso.port });
    running.push(again);
    expect((await again.api<{ ok: boolean }>("/api/health")).ok).toBe(true);
  });

  it("replaces a stale lock left by a dead process", async () => {
    const { home, pathDir } = await makeHome();
    await writeFile(path.join(home, "laisso.pid"), JSON.stringify({ pid: 2147483000, port: 1 }));
    const laisso = await startLaisso({ home, pathDir });
    running.push(laisso);
    expect((await laisso.api<{ ok: boolean }>("/api/health")).ok).toBe(true);
  });

  it("exits 1 with a clear message when the port is taken by another process", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const squatter = createServer().listen(port, "127.0.0.1");
    try {
      const result = await runCli([], { home, pathDir, port });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`port ${port} is in use`);
      expect(existsSync(path.join(home, "laisso.pid"))).toBe(false);
    } finally {
      squatter.close();
    }
  });

  it("serves the dashboard page and an empty ledger", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    // The page is the React app's entry; its header and Ledger are tested as components (test/app.test.tsx).
    const html = await (await laisso.page("/")).text();
    expect(html).toContain('<div id="root"></div>');

    const tickets = await laisso.api<unknown[]>("/api/tickets");
    expect(tickets).toEqual([]);

    const tick = await laisso.api<{ tickSeconds: number; lastTick: string | null }>("/api/tick");
    expect(tick.tickSeconds).toBe(3600);
    expect(tick.lastTick).toBeTypeOf("string");

    const check = await laisso.api<{ changes: unknown[] }>("/api/check-now", { method: "POST" });
    expect(check.changes).toEqual([]);
  });

  it("logs one line per event to stdout and to laisso.log", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    await laisso.api("/api/check-now", { method: "POST" });
    const log = await readFile(path.join(laisso.home, "laisso.log"), "utf8");
    expect(log).toMatch(/ started .*port=/);
    expect(log).toMatch(/ tick /);
    expect(laisso.stdout()).toMatch(/ tick /);
  });
});

describe("laisso status as a client", () => {
  it("fails with 'laisso is not running' when the server is down", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const result = await runCli(["status"], { home, pathDir, port });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("laisso is not running");
  });

  it("treats a foreign service on the port as laisso not running", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const stranger = createServer((_req, res) => res.end("<html>hello</html>")).listen(port, "127.0.0.1");
    try {
      const result = await runCli(["status"], { home, pathDir, port });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("laisso is not running");
    } finally {
      stranger.close();
    }
  });

  it("reports an unknown Ticket by name", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    const result = await runCli(["status", "LASSO-999"], laisso);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no Ticket matches LASSO-999");
  });

  it("prints an empty ledger when the server is up", async () => {
    const laisso = await startLaisso();
    running.push(laisso);
    const result = await runCli(["status"], laisso);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no active Tickets");
    const json = await runCli(["status", "--json"], laisso);
    expect(JSON.parse(json.stdout)).toEqual({ tickets: [] });
  });
});
