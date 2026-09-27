import { execFile } from "node:child_process";

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
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

/** Run a tracker CLI (gh, acli) and report what it said; never throws on a non-zero exit. */
export function runTool(command: string, args: string[], opts: { cwd?: string } = {}): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd }, (error, stdout, stderr) => {
      const e = error as (Error & { code?: unknown }) | null;
      const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") + (e && typeof e.code !== "number" ? e.message : "") });
    });
  });
}
