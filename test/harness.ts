// Test harness for the Lasso v1 test seam: the localhost JSON API, end to end.
//
// Each test gets a temporary Lasso home, the server spawned as a child process,
// a PATH directory for fake executables, and a fake notifier on that PATH that
// records what it was asked to post. Later slices add a fake Runner and the gh
// and acli shims to the same directory. Time is driven by check-now, never by
// timers: the harness config sets a tick cadence long enough never to fire.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "lasso.js");

import type { Config } from "../src/server/config.ts";

/** What a test writes to config.yaml: any subset of the real Config. */
export type LassoConfig = {
  [K in keyof Config]?: Config[K] extends object ? Partial<Config[K]> : Config[K];
};

export interface Lasso {
  home: string;
  pathDir: string;
  port: number;
  url: string;
  child: ChildProcess;
  /** Everything the server wrote to stdout so far. */
  stdout(): string;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** JSON request against the API; throws on non-2xx unless `raw` is set. */
  api<T = unknown>(route: string, init?: RequestInit & { raw?: boolean }): Promise<T>;
  /** Fetch a page (HTML) as text. */
  page(route: string): Promise<Response>;
  /** The notifications the fake notifier recorded, oldest first. */
  notifications(): Promise<Array<{ title: string; body: string; url?: string }>>;
  /** SIGINT the server and wait for exit; the home is left in place. */
  stop(): Promise<number | null>;
  /** Stop and delete the home. */
  destroy(): Promise<void>;
}

export interface StartOptions {
  home?: string;
  pathDir?: string;
  port?: number;
  config?: LassoConfig;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
}

export async function makeHome(config: LassoConfig = {}): Promise<{ home: string; pathDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lasso-test-"));
  const home = path.join(root, "home");
  const pathDir = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(pathDir, { recursive: true });
  await writeConfig(home, { tick: 3600, ...config });
  await installFakeNotifier(pathDir);
  return { home, pathDir };
}

export async function writeConfig(home: string, config: LassoConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.yaml"), stringify(config));
}

async function installFakeNotifier(pathDir: string): Promise<void> {
  // The fake notifier appends one JSON line per call to notifications.jsonl
  // beside itself. Lasso's macOS adapter looks for terminal-notifier on PATH.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flags = { "-title": "title", "-message": "body", "-open": "url" };
const record = {};
for (let i = 0; i < args.length; i++) {
  const key = flags[args[i]];
  if (key) { record[key] = args[i + 1] ?? ""; i++; }
}
fs.appendFileSync(path.join(__dirname, "notifications.jsonl"), JSON.stringify(record) + "\\n");
`;
  await writeFile(path.join(pathDir, "terminal-notifier"), script, { mode: 0o755 });
}

export function serverEnv(home: string, pathDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LASSO_HOME: home,
    PATH: `${pathDir}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startLasso(opts: StartOptions = {}): Promise<Lasso> {
  const { home, pathDir } = opts.home
    ? { home: opts.home, pathDir: opts.pathDir ?? path.join(opts.home, "..", "bin") }
    : await makeHome(opts.config);
  const port = opts.port ?? (await freePort());
  const url = `http://localhost:${port}`;
  const child = spawn(process.execPath, [BIN, "--port", String(port)], {
    env: serverEnv(home, pathDir, opts.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d.toString()));
  child.stderr!.on("data", (d) => (err += d.toString()));

  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await waitForHealth(url, exited, () => out + err);

  const lasso: Lasso = {
    home,
    pathDir,
    port,
    url,
    child,
    stdout: () => out,
    stderr: () => err,
    async api<T>(route: string, init: RequestInit & { raw?: boolean } = {}) {
      const { raw, ...rest } = init;
      const res = await fetch(url + route, {
        ...rest,
        headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
      });
      if (raw) return res as unknown as T;
      const text = await res.text();
      if (!res.ok) throw new Error(`${rest.method ?? "GET"} ${route} -> ${res.status}: ${text}`);
      return (text ? JSON.parse(text) : undefined) as T;
    },
    page: (route) => fetch(url + route),
    async notifications() {
      try {
        const text = await readFile(path.join(pathDir, "notifications.jsonl"), "utf8");
        return text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
    async destroy() {
      await lasso.stop();
      await rm(path.dirname(home), { recursive: true, force: true });
    },
  };
  return lasso;
}

async function waitForHealth(url: string, exited: Promise<number | null>, out: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let done = false;
  exited.then(() => (done = true));
  while (Date.now() < deadline) {
    if (done) throw new Error(`lasso exited before becoming healthy:\n${out()}`);
    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`lasso did not become healthy in time:\n${out()}`);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the lasso CLI as a client against a home/port. */
export function runCli(
  args: string[],
  ctx: { home: string; pathDir: string; port: number; env?: Record<string, string>; stdin?: string },
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, "--port", String(ctx.port), ...args],
      { env: serverEnv(ctx.home, ctx.pathDir, ctx.env), maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (ctx.stdin !== undefined) child.stdin?.end(ctx.stdin);
    else child.stdin?.end();
  });
}
