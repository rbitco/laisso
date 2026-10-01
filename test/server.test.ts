import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { startLasso, runCli, makeHome, freePort, type Lasso } from "./harness.ts";

const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

describe("the lasso process", () => {
  it("starts, answers health, and writes the default config and Pipeline once", async () => {
    const lasso = await startLasso();
    running.push(lasso);

    const health = await lasso.api<{ ok: boolean; pid: number }>("/api/health");
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(lasso.child.pid);

    const pipeline = await readFile(path.join(lasso.home, "pipelines", "default.yaml"), "utf8");
    expect(pipeline).toContain("name: grill");
    expect(pipeline).toContain("action: tracker.transition");

    // A hand edit survives a restart: the default is written only when absent.
    await lasso.stop();
    await writeFile(path.join(lasso.home, "pipelines", "default.yaml"), pipeline + "\n# hand edit\n");
    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    const after = await readFile(path.join(lasso.home, "pipelines", "default.yaml"), "utf8");
    expect(after).toContain("# hand edit");
  });

  it("writes a default config.yaml on first run when the home is empty", async () => {
    const { home, pathDir } = await makeHome();
    await rm(path.join(home, "config.yaml"));
    const lasso = await startLasso({ home, pathDir });
    running.push(lasso);
    const config = await readFile(path.join(home, "config.yaml"), "utf8");
    expect(config).toContain("tick: 60");
    expect(config).toContain("concurrency: 3");
    expect(config).toContain("port: 7433");
  });

  it("refuses a second lasso with the running URL and pid", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    const second = await runCli([], lasso);
    expect(second.code).toBe(1);
    expect(second.stderr + second.stdout).toContain(
      `lasso already running at http://localhost:${lasso.port} (pid ${lasso.child.pid})`,
    );
  });

  it("releases the lock on Ctrl-C so the next start succeeds", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    const code = await lasso.stop();
    expect(code).toBe(0);
    const again = await startLasso({ home: lasso.home, pathDir: lasso.pathDir, port: lasso.port });
    running.push(again);
    expect((await again.api<{ ok: boolean }>("/api/health")).ok).toBe(true);
  });

  it("replaces a stale lock left by a dead process", async () => {
    const { home, pathDir } = await makeHome();
    await writeFile(path.join(home, "lasso.pid"), JSON.stringify({ pid: 2147483000, port: 1 }));
    const lasso = await startLasso({ home, pathDir });
    running.push(lasso);
    expect((await lasso.api<{ ok: boolean }>("/api/health")).ok).toBe(true);
  });

  it("exits 1 with a clear message when the port is taken by another process", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const squatter = createServer().listen(port, "127.0.0.1");
    try {
      const result = await runCli([], { home, pathDir, port });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`port ${port} is in use`);
      expect(existsSync(path.join(home, "lasso.pid"))).toBe(false);
    } finally {
      squatter.close();
    }
  });

  it("serves the dashboard shell and an empty ledger", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    const html = await (await lasso.page("/")).text();
    expect(html).toContain('data-role="intake"');
    expect(html).toContain('data-role="tick-dot"');
    expect(html).toContain('data-role="check-now"');
    expect(html).toContain('data-role="ledger"');

    const tickets = await lasso.api<unknown[]>("/api/tickets");
    expect(tickets).toEqual([]);

    const tick = await lasso.api<{ tickSeconds: number; lastTick: string | null }>("/api/tick");
    expect(tick.tickSeconds).toBe(3600);
    expect(tick.lastTick).toBeTypeOf("string");

    const check = await lasso.api<{ changes: unknown[] }>("/api/check-now", { method: "POST" });
    expect(check.changes).toEqual([]);
  });

  it("logs one line per event to stdout and to lasso.log", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    await lasso.api("/api/check-now", { method: "POST" });
    const log = await readFile(path.join(lasso.home, "lasso.log"), "utf8");
    expect(log).toMatch(/ started .*port=/);
    expect(log).toMatch(/ tick /);
    expect(lasso.stdout()).toMatch(/ tick /);
  });
});

describe("lasso status as a client", () => {
  it("fails with 'lasso is not running' when the server is down", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const result = await runCli(["status"], { home, pathDir, port });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lasso is not running");
  });

  it("treats a foreign service on the port as lasso not running", async () => {
    const { home, pathDir } = await makeHome();
    const port = await freePort();
    const stranger = createServer((_req, res) => res.end("<html>hello</html>")).listen(port, "127.0.0.1");
    try {
      const result = await runCli(["status"], { home, pathDir, port });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("lasso is not running");
    } finally {
      stranger.close();
    }
  });

  it("reports an unknown Ticket by name", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    const result = await runCli(["status", "LASSO-999"], lasso);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no Ticket matches LASSO-999");
  });

  it("prints an empty ledger when the server is up", async () => {
    const lasso = await startLasso();
    running.push(lasso);
    const result = await runCli(["status"], lasso);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no active Tickets");
    const json = await runCli(["status", "--json"], lasso);
    expect(JSON.parse(json.stdout)).toEqual({ tickets: [] });
  });
});
