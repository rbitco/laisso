// Smoke test for a packed Lasso: installs the tarball globally into a temporary prefix, starts the installed
// `lasso` against a temporary Lasso home on a free port, and checks it serves its API and dashboard. The
// release workflow runs it on the tarball it is about to publish; test/package.test.ts runs it on a fresh pack.
//
//   node scripts/smoke-test.ts <tarball> <expected version>

import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface SmokeOptions {
  tarball: string;
  version: string;
  /** Progress lines; silent by default. */
  log?: (line: string) => void;
}

/** Resolves when the installed Lasso answered as expected and has stopped; throws naming what went wrong. */
export async function smokeTest({ tarball, version, log = () => {} }: SmokeOptions): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "lasso-smoke-"));
  const prefix = path.join(root, "prefix");
  const home = path.join(root, "home");
  try {
    log(`installing ${tarball} into ${prefix}`);
    await promisify(execFile)("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", path.resolve(tarball)]);
    const port = await freePort();
    log(`starting lasso on port ${port} with LASSO_HOME=${home}`);
    const child = spawn(path.join(prefix, "bin", "lasso"), ["--port", String(port)], { env: { ...process.env, LASSO_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      const url = `http://localhost:${port}`;
      const health = await waitForHealth(url, exited, () => output);
      if (health.version !== version) throw new Error(`/api/health reports version ${String(health.version)}, expected ${version}`);
      log(`/api/health ok, version ${version}`);
      const page = await fetch(url + "/");
      const html = await page.text();
      if (!page.ok || !html.includes('<div id="root">')) throw new Error(`/ did not serve the dashboard (HTTP ${page.status}): ${html.slice(0, 200)}`);
      log("/ serves the dashboard");
    } finally {
      if (child.exitCode === null) child.kill("SIGINT");
      await exited;
    }
    log("stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForHealth(url: string, exited: Promise<number | null>, output: () => string, timeoutMs = 15_000): Promise<{ version?: unknown }> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gone) throw new Error(`lasso exited before serving:\n${output()}`);
    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) return (await res.json()) as { version?: unknown };
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`lasso did not answer /api/health within ${timeoutMs} ms:\n${output()}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

if (import.meta.main) {
  const [tarball, version] = process.argv.slice(2);
  if (!tarball || !version) {
    console.error("usage: node scripts/smoke-test.ts <tarball> <expected version>");
    process.exit(2);
  }
  smokeTest({ tarball, version, log: (line) => console.log(line) }).then(
    () => console.log("smoke test passed"),
    (error) => {
      console.error(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
