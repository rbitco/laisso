import { execFile } from "node:child_process";

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Why the CLI never ran (ENOENT and the like), when it did not. */
  errno?: string;
}

/** The first line the CLI said, minus acli's ✗/✓ glyph, falling back to stdout and then to the exit code. */
export function failureReason(tool: string, r: ToolResult): string {
  const line = (r.stderr.trim() || r.stdout.trim()).split("\n")[0]?.replace(/^[✗✓]\s*/, "").trim();
  return line || `${tool} exited ${r.code}`;
}

/** Parse the CLI's stdout as JSON, or say which tool did not answer in JSON for which reference. */
export function parseJson<T>(tool: string, reference: string, stdout: string, onError: (message: string) => Error): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw onError(`${reference}: ${tool} returned something other than JSON`);
  }
}

/** How long a tracker CLI may run before it is killed, so a hung gh or acli cannot stall a tick. */
export const TOOL_TIMEOUT_MS = 30_000;

/** Run a tracker CLI (gh, acli) and report what it said; never throws on a non-zero exit. Killed past `timeoutMs`. */
export function runTool(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ToolResult> {
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      const e = error as (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
      // A timeout leaves no exit code; its reason goes first so failureReason reports it.
      if (e?.killed && e.signal === "SIGKILL") {
        resolve({ code: 1, stdout: stdout ?? "", stderr: `${command} timed out after ${timeoutMs / 1000}s\n${stderr ?? ""}` });
        return;
      }
      const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
      const errno = e && typeof e.code === "string" ? { errno: e.code } : {};
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") + (e && typeof e.code !== "number" ? e.message : ""), ...errno });
    });
  });
}
