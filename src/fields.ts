import { parseDuration } from "./duration.ts";

/**
 * Checks on one field of a parsed YAML mapping, shared by the Pipeline and
 * config parsers. `what` names the field in the message; `fail` builds the
 * caller's error class. A fallback, where given, stands in for an absent
 * value; a value that is present but wrong is always an error.
 */
export type Fail = (message: string) => Error;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapping(value: unknown, what: string, fail: Fail): Record<string, unknown> {
  if (absent(value)) return {};
  if (!isPlainObject(value)) throw fail(`${what} must be a mapping, not ${String(value)}`);
  return value;
}

export function count(value: unknown, what: string, fail: Fail, fallback?: number): number {
  if (absent(value) && fallback !== undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw fail(`${what} must be a whole number of 0 or more, not ${String(value)}`);
}

export function positive(value: unknown, what: string, fail: Fail, fallback?: number): number {
  if (absent(value) && fallback !== undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw fail(`${what} must be a whole number of 1 or more, not ${String(value)}`);
}

export function money(value: unknown, what: string, fail: Fail, fallback?: number): number {
  if (absent(value) && fallback !== undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw fail(`${what} must be a number of 0 or more USD, not ${String(value)}`);
}

export function flag(value: unknown, what: string, fail: Fail, fallback?: boolean): boolean {
  if (absent(value) && fallback !== undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw fail(`${what} must be true or false, not ${String(value)}`);
}

export function text(value: unknown, what: string, fail: Fail, fallback?: string): string {
  if (absent(value) && fallback !== undefined) return fallback;
  if (typeof value === "string") return value;
  throw fail(`${what} must be text, not ${String(value)}`);
}

export function duration(value: unknown, what: string, fail: Fail, fallback?: string): string {
  if (absent(value) && fallback !== undefined) return fallback;
  try {
    parseDuration(value);
  } catch (error) {
    throw fail(`${what} ${error instanceof Error ? error.message : String(error)}`);
  }
  return value as string;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}
