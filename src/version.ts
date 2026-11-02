/** The version a source checkout carries in git; releases take theirs from the tag (LASSO-88). */
export const DEV_VERSION = "0.0.0-dev";

/** A dev build: run from a clone, not installed from the registry. The dashboard marks it so the two are not confused. */
export function isDevVersion(version: string): boolean {
  return version === DEV_VERSION;
}
