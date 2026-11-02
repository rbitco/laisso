export class DurationError extends Error {}

/** "30m", "90s", "2h", "1h30m" to milliseconds. Anything else is a configuration mistake and throws. */
export function parseDuration(text: unknown): number {
  const m = typeof text === "string" ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim()) : null;
  if (!m || !m[0]) throw new DurationError(`${JSON.stringify(text)} is not a duration like 30m, 90s, or 1h30m`);
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}
