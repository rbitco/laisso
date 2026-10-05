// Test harness for the Lasso v1 test seam: the localhost JSON API, end to end.
//
// Each test gets a temporary Lasso home, the server spawned as a child process,
// a PATH directory for fake executables, and a fake notifier on that PATH that
// records what it was asked to post, and gh and acli shims that answer from
// canned replies and record every invocation, and a fake Runner (claude, codex, pi) that
// plays a script (stdout, exit code, commands to run and files to write in its
// cwd, or hang) and records every launch. Time is driven by check-now, never
// by timers: the harness config sets a tick cadence long enough never to fire.

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "lasso.js");

import type { Config, RepoConfig } from "../src/server/config.ts";
import { parsePipeline } from "../src/pipeline/load.ts";
import { DEFAULT_PIPELINE_YAML } from "../src/pipeline/default.ts";

const DEFAULT_PIPELINE_STATUSES = [...new Set(parsePipeline("default", DEFAULT_PIPELINE_YAML).stages.flatMap((s) => (s.kind === "action" && "status" in s ? [s.status] : [])))];

/** What a test writes to config.yaml: any subset of the real Config. */
/** An Action as a test writes it: params and timeout may be left to their defaults. */
export type ActionSpec = { run: string; params?: string[]; timeout?: string };

export type LassoConfig = {
  [K in Exclude<keyof Config, "actions" | "repos">]?: Config[K] extends object ? Partial<Config[K]> : Config[K];
} & { actions?: Record<string, ActionSpec>; repos?: Record<string, Partial<Omit<RepoConfig, "actions">> & { actions?: Record<string, ActionSpec> }> };

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
  /** The gh and acli shims: canned replies in, recorded invocations out. */
  tracker: TrackerShim;
  /** The fake Runner behind claude, codex and pi: a script in, recorded launches out. */
  runner: RunnerShim;
  /** The fake osascript: what Terminal.app was told to run, oldest first. */
  terminals(): Promise<Array<{ script: string; launcher: string | null }>>;
  /** Make the fake notifier exit 1 from now on, so a post fails. */
  breakNotifier(): Promise<void>;
  /** SIGINT the server and wait for exit; the home is left in place. */
  stop(): Promise<number | null>;
  /** SIGKILL the server, as a crash would: nothing is reconciled on the way out. */
  kill(): Promise<void>;
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
  await installTrackerShims(pathDir);
  await installFakeRunner(pathDir);
  await installFakeOsascript(pathDir);
  return { home, pathDir };
}

async function installFakeOsascript(pathDir: string): Promise<void> {
  // Records each -e script; a `do script "<path>"` line is pulled out as the launcher.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const script = args.filter((a, i) => args[i - 1] === "-e").join("\\n");
const m = /do script "((?:[^"\\\\]|\\\\.)*)"/.exec(script);
const line = m ? m[1].replace(/\\\\(.)/g, "$1") : null;
const quoted = line && /^'(.*)'$/.exec(line);
fs.appendFileSync(path.join(__dirname, "osascript-calls.jsonl"), JSON.stringify({ script, launcher: quoted ? quoted[1].replace(/'\\\\''/g, "'") : line }) + "\\n");
`;
  await writeFile(path.join(pathDir, "osascript"), script, { mode: 0o755 });
}

/** What the fake Runner does when launched. Fields apply in this order. */
export interface RunnerScript {
  /** Written to stdout, one line at a time; a recorded fixture goes in whole. */
  stdout?: string;
  /** Per-Runner stdout (keyed claude, codex, pi) when one script serves several; wins over `stdout`. */
  stdoutByRunner?: Record<string, string>;
  /** Wait this long before writing stdout, so a test can watch the Session run. */
  delayMs?: number;
  /** Files to write in the cwd (the worktree), relative path to content. */
  files?: Record<string, string>;
  /** Commands to run in the cwd before exiting, such as a git commit. */
  commands?: string[][];
  /** Never exit: the Session runs until something kills it. */
  hang?: boolean;
  exit?: number;
}

export interface RunnerCall {
  pid: number;
  /** argv[0] is the Runner launched: claude, codex or pi. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface RunnerShim {
  /** Set what the next launches do; the script stays until replaced. */
  script(script: RunnerScript): Promise<void>;
  /** Every launch so far, oldest first. */
  calls(): Promise<RunnerCall[]>;
}

const RUNNER_SCRIPT_FILE = "runner-script.json";
const RUNNER_CALLS_FILE = "runner-calls.jsonl";

async function installFakeRunner(pathDir: string): Promise<void> {
  // With no script it exits at once with nothing on stdout, which Lasso reads
  // as interrupted: a test that runs a Stage sets a script first.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("LASSO_")));
fs.appendFileSync(path.join(__dirname, ${JSON.stringify(RUNNER_CALLS_FILE)}), JSON.stringify({ pid: process.pid, argv: [path.basename(process.argv[1]), ...process.argv.slice(2)], cwd: process.cwd(), env }) + "\\n");
let script = {};
try { script = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(RUNNER_SCRIPT_FILE)}), "utf8")); } catch {}
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
(async () => {
  if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
  for (const [file, content] of Object.entries(script.files ?? {})) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), content);
  }
  for (const [cmd, ...args] of script.commands ?? []) execFileSync(cmd, args, { env: gitEnv, stdio: ["ignore", "ignore", "inherit"] });
  const stdout = (script.stdoutByRunner ?? {})[path.basename(process.argv[1])] ?? script.stdout;
  if (stdout) for (const line of stdout.split("\\n")) process.stdout.write(line + "\\n");
  if (script.hang) { setInterval(() => {}, 1000); return; }
  process.exit(script.exit ?? 0);
})();
`;
  for (const runner of ["claude", "codex", "pi"]) await writeFile(path.join(pathDir, runner), script, { mode: 0o755 });
}

export function runnerShim(pathDir: string): RunnerShim {
  return {
    script: (script) => writeFile(path.join(pathDir, RUNNER_SCRIPT_FILE), JSON.stringify(script)),
    calls: () => readJsonl<RunnerCall>(path.join(pathDir, RUNNER_CALLS_FILE)),
  };
}

/** Poll until `probe` returns a truthy value, or fail with the last value seen. */
export async function waitFor<T>(probe: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

/** Output recorded from a real Runner, from test/fixtures/<runner>. */
export function runnerFixture(runner: string, name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", runner, name), "utf8");
}

/** Output recorded from a real claude run, from test/fixtures/claude. */
export const claudeFixture = (name: string): string => runnerFixture("claude", name);

export interface TrackerReply {
  tool: "gh" | "acli";
  /** Every string must appear in the invocation's arguments joined by spaces. */
  match: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Consumed by the first invocation it matches, so a later identical call falls through to the next reply. */
  once?: boolean;
  /** Hold the answer this long: a tracker that never comes back. */
  sleepMs?: number;
}

export interface TrackerCall {
  tool: "gh" | "acli";
  args: string[];
}

export interface TrackerShim {
  /** Add a canned reply; the first reply whose `match` strings all appear wins, so `first` puts this one ahead of the rest. */
  reply(reply: TrackerReply, first?: boolean): Promise<void>;
  /** Every gh and acli invocation so far, oldest first. */
  calls(): Promise<TrackerCall[]>;
  /** Forget recorded calls (replies stay). */
  clearCalls(): Promise<void>;
}

const REPLIES_FILE = "tracker-replies.json";
const CALLS_FILE = "tracker-calls.jsonl";

async function installTrackerShims(pathDir: string): Promise<void> {
  // Both shims record argv and answer from the same replies file. An
  // invocation nothing matches exits 1 so a test fails on an unexpected call.
  const script = (tool: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, ${JSON.stringify(CALLS_FILE)}), JSON.stringify({ tool: ${JSON.stringify(tool)}, args }) + "\\n");
let replies = [];
try { replies = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(REPLIES_FILE)}), "utf8")); } catch {}
const joined = args.join(" ");
const hit = replies.find((r) => r.tool === ${JSON.stringify(tool)} && r.match.every((m) => joined.includes(m)));
if (!hit) { process.stderr.write("shim: no reply for ${tool} " + joined + "\\n"); process.exit(1); }
if (hit.once) fs.writeFileSync(path.join(__dirname, ${JSON.stringify(REPLIES_FILE)}), JSON.stringify(replies.filter((r) => r !== hit)));
if (hit.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hit.sleepMs);
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code ?? 0);
`;
  await writeFile(path.join(pathDir, "gh"), script("gh"), { mode: 0o755 });
  await writeFile(path.join(pathDir, "acli"), script("acli"), { mode: 0o755 });
}

export function trackerShim(pathDir: string): TrackerShim {
  const repliesFile = path.join(pathDir, REPLIES_FILE);
  const callsFile = path.join(pathDir, CALLS_FILE);
  return {
    async reply(reply, first = false) {
      let replies: TrackerReply[] = [];
      try {
        replies = JSON.parse(await readFile(repliesFile, "utf8"));
      } catch {
        // first reply
      }
      if (first) replies.unshift(reply);
      else replies.push(reply);
      await writeFile(repliesFile, JSON.stringify(replies));
    },
    calls: () => readJsonl<TrackerCall>(callsFile),
    async clearCalls() {
      await rm(callsFile, { force: true });
    },
  };
}

/** One record per line; a file nothing has written yet reads as empty. */
async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export interface RepoSpec {
  tracker?: RepoConfig["tracker"];
  /** Defaults to the repo name upper-cased for JIRA, owner/name for GitHub. */
  project?: string;
  pipeline?: string;
  actions?: Record<string, ActionSpec>;
  profiles?: RepoConfig["profiles"];
  default_profile?: string;
}

export interface LassoWithRepos {
  lasso: Lasso;
  repos: Record<string, Awaited<ReturnType<typeof makeRepo>>>;
}

/**
 * A running Lasso whose config names one real temp git repo per entry, plus
 * any extra config and Pipelines. The default Pipeline transitions through
 * three JIRA statuses; the acli shim is seeded to accept each so a reference
 * intake into a JIRA repo passes the status check without every test saying so.
 */
export async function startLassoWithRepos(specs: Record<string, RepoSpec>, extra: LassoConfig = {}, pipelines: Record<string, string> = {}, env?: Record<string, string>): Promise<LassoWithRepos> {
  const { home, pathDir } = await makeHome();
  const repos: LassoWithRepos["repos"] = {};
  const config: NonNullable<LassoConfig["repos"]> = {};
  for (const [name, spec] of Object.entries(specs)) {
    repos[name] = await makeRepo(path.join(home, "..", "repos"), name);
    const tracker = spec.tracker ?? "jira";
    config[name] = { tracker, project: spec.project ?? (tracker === "jira" ? name.toUpperCase() : `owner/${name}`), path: repos[name].path, pipeline: spec.pipeline ?? "default", ...(spec.actions ? { actions: spec.actions } : {}), ...(spec.profiles ? { profiles: spec.profiles } : {}), ...(spec.default_profile ? { default_profile: spec.default_profile } : {}) };
  }
  await writeConfig(home, { tick: 3600, repos: config, ...extra });
  for (const [name, yaml] of Object.entries(pipelines)) {
    await mkdir(path.join(home, "pipelines"), { recursive: true });
    await writeFile(path.join(home, "pipelines", `${name}.yaml`), yaml);
  }
  const lasso = await startLasso({ home, pathDir, env });
  for (const status of DEFAULT_PIPELINE_STATUSES) {
    await lasso.tracker.reply({ tool: "acli", match: ["workitem search", `status = "${status}"`], stdout: "[]" });
  }
  return { lasso, repos };
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
if (fs.existsSync(path.join(__dirname, "notifier-broken"))) { process.stderr.write("terminal-notifier: broken\\n"); process.exit(1); }
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
    tracker: trackerShim(pathDir),
    runner: runnerShim(pathDir),
    terminals: () => readJsonl(path.join(pathDir, "osascript-calls.jsonl")),
    breakNotifier: () => writeFile(path.join(pathDir, "notifier-broken"), ""),
    notifications: () => readJsonl(path.join(pathDir, "notifications.jsonl")),
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
    async kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
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

// --- git ---------------------------------------------------------------------

export interface TempRepo {
  /** The bare origin. */
  origin: string;
  /** The local checkout Lasso is configured with; worktrees hang off it. */
  path: string;
  defaultBranch: string;
  git(args: string[], cwd?: string): string;
}

/** A real git origin (bare) plus a clone with one commit on `main`, for intake tests. */
export async function makeRepo(root: string, name = "app"): Promise<TempRepo> {
  const git = (args: string[], cwd = clone) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = path.join(root, `${name}.git`);
  const clone = path.join(root, name);
  await mkdir(root, { recursive: true });
  git(["init", "--bare", "-b", "main", origin], root);
  git(["clone", "-q", origin, clone], root);
  await writeFile(path.join(clone, "README.md"), `# ${name}\n`);
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
  return { origin, path: clone, defaultBranch: "main", git };
}
