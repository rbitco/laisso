import { appendFileSync, renameSync, statSync, existsSync } from "node:fs";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** One line per event to stdout and to a size-rotated log file. Session transcripts never go here. */
export function createLogger(file: string, out: { write(text: string): unknown } = process.stdout): Logger {
  const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    const rendered = Object.entries(fields)
      .map(([k, v]) => `${k}=${render(v)}`)
      .join(" ");
    const line = `${new Date().toISOString()} ${level} ${event}${rendered ? " " + rendered : ""}\n`;
    out.write(line);
    try {
      rotateIfNeeded(file);
      appendFileSync(file, line);
    } catch {
      // logging must never take the process down
    }
  };
  return {
    info: (event, fields) => write("INFO", event, fields),
    warn: (event, fields) => write("WARN", event, fields),
    error: (event, fields) => write("ERROR", event, fields),
  };
}

function render(value: unknown): string {
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}
