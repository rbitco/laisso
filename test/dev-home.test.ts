import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { devEnv, laissoArgs } from "../scripts/dev-env.ts";
import { ConfigError, DEFAULT_CONFIG, DEFAULT_CONFIG_YAML } from "../src/server/config.ts";
import { ensureHome, resolveHome } from "../src/server/home.ts";
import { freePort, startLaisso, runCli, type Laisso } from "./harness.ts";
import type { Health } from "../src/api/views.ts";

// A dev clone's `pnpm start` and `pnpm dev` run in their own Laisso home and port, so the installed Laisso and a dev
// clone run side by side; `laisso status` says which one answered.

const START = path.resolve(import.meta.dirname, "..", "scripts", "start.ts");

describe("the dev clone's defaults", () => {
  it("are ~/.laisso-dev and port 7434 when LAISSO_HOME and LAISSO_PORT are unset or empty", () => {
    expect(devEnv({}, "/Users/me")).toEqual({ LAISSO_HOME: "/Users/me/.laisso-dev", LAISSO_PORT: "7434" });
    expect(devEnv({ LAISSO_HOME: "", LAISSO_PORT: "" }, "/Users/me")).toEqual({ LAISSO_HOME: "/Users/me/.laisso-dev", LAISSO_PORT: "7434" });
  });

  it("give way to an explicit LAISSO_HOME or LAISSO_PORT, each on its own", () => {
    expect(devEnv({ LAISSO_HOME: "/Users/me/.laisso" }, "/Users/me")).toEqual({ LAISSO_HOME: "/Users/me/.laisso", LAISSO_PORT: "7434" });
    expect(devEnv({ LAISSO_PORT: "7500" }, "/Users/me")).toEqual({ LAISSO_HOME: "/Users/me/.laisso-dev", LAISSO_PORT: "7500" });
  });

  it("pass Laisso's arguments through, without the -- pnpm keeps", () => {
    expect(laissoArgs(["--", "--port", "7500"])).toEqual(["--port", "7500"]);
    expect(laissoArgs(["--", "status"])).toEqual(["status"]);
    expect(laissoArgs(["status", "--json"])).toEqual(["status", "--json"]);
    expect(laissoArgs([])).toEqual([]);
  });
});

describe("a new home's config.yaml", () => {
  const newHome = () => resolveHome({ LAISSO_HOME: mkdtempSync(path.join(tmpdir(), "laisso-devhome-")) });

  it("takes its port from LAISSO_PORT and is otherwise the default", () => {
    const home = newHome();
    expect(ensureHome(home, { LAISSO_PORT: "7434" }).wroteConfig).toBe(true);
    const text = readFileSync(home.configFile, "utf8");
    expect(text).toContain("port: 7434         # dashboard and API port");
    expect(parse(text)).toEqual({ ...DEFAULT_CONFIG, port: 7434 });
  });

  it("is the default without LAISSO_PORT", () => {
    const home = newHome();
    ensureHome(home, {});
    expect(readFileSync(home.configFile, "utf8")).toBe(DEFAULT_CONFIG_YAML);
  });

  it("is never rewritten for LAISSO_PORT once it exists", () => {
    const home = newHome();
    ensureHome(home, {});
    writeFileSync(home.configFile, "port: 9000\n");
    expect(ensureHome(home, { LAISSO_PORT: "7434" }).wroteConfig).toBe(false);
    expect(readFileSync(home.configFile, "utf8")).toBe("port: 9000\n");
  });

  it("refuses a LAISSO_PORT that is not a port number, and writes nothing", () => {
    for (const bad of ["abc", "0", "70000", "74.5"]) {
      const home = newHome();
      expect(() => ensureHome(home, { LAISSO_PORT: bad })).toThrow(new ConfigError(`LAISSO_PORT must be a port number, not ${bad}`));
      expect(existsSync(home.configFile)).toBe(false);
    }
  });
});

/** The environment `pnpm start` sees in a clone: a home directory of its own, no LAISSO_HOME, and the given LAISSO_PORT. */
function cloneEnv(homedir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homedir, LAISSO_PORT: String(port) };
  delete env.LAISSO_HOME;
  return env;
}

function runStart(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [START, ...args], { env }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("pnpm start in a dev clone", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("runs in ~/.laisso-dev on LAISSO_PORT beside an installed Laisso, and status says which answered", async () => {
    const installed: Laisso = await startLaisso();
    cleanups.push(() => installed.destroy());

    const homedir = await mkdtemp(path.join(tmpdir(), "laisso-clone-"));
    cleanups.push(() => rm(homedir, { recursive: true, force: true }));
    const port = await freePort();
    const env = cloneEnv(homedir, port);
    const child: ChildProcess = spawn(process.execPath, [START], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d.toString()));
    child.stderr!.on("data", (d) => (out += d.toString()));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill("SIGINT");
      await exited;
    });

    const devHome = path.join(homedir, ".laisso-dev");
    const health = await waitForHealth(`http://localhost:${port}`, () => out);
    expect(health).toMatchObject({ ok: true, version: "0.0.0-dev", home: devHome });
    expect(parse(readFileSync(path.join(devHome, "config.yaml"), "utf8")).port).toBe(port);

    // Both answer, each from its own home.
    expect((await installed.api<Health>("/api/health")).home).toBe(installed.home);

    const dev = await runStart(["--", "status"], env);
    expect(dev.code).toBe(0);
    expect(dev.stdout.split("\n")[0]).toBe(`laisso 0.0.0-dev  home ${devHome}`);
    const other = await runCli(["status"], installed);
    expect(other.stdout.split("\n")[0]).toBe(`laisso 0.0.0-dev  home ${installed.home}`);
  });

  it("takes Laisso's options after the -- pnpm passes through", async () => {
    const homedir = await mkdtemp(path.join(tmpdir(), "laisso-clone-"));
    cleanups.push(() => rm(homedir, { recursive: true, force: true }));
    const env = cloneEnv(homedir, await freePort());
    const help = await runStart(["--", "--help"], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("usage:");
    // Nothing listens on the port: the client got past argument parsing to the request.
    const status = await runStart(["--", "--port", String(await freePort()), "status"], env);
    expect(status.stderr.trim()).toBe("laisso is not running");
  });
});

async function waitForHealth(url: string, out: () => string): Promise<Health> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) return (await res.json()) as Health;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the dev Laisso did not become healthy in time:\n${out()}`);
}
