import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Lasso's own package name; a package.json with any other name is someone else's and the walk goes on past it. */
export const PACKAGE_NAME = "@rbitco/lasso";

/** Where Lasso's own files are: the same answer from a source checkout and from an installed bundle in any prefix. */
export interface PackageRoot {
  /** The directory holding Lasso's package.json. */
  root: string;
  version: string;
  /** Where `pnpm build` writes the dashboard (ADR 0012); shipped in the package, not committed. */
  dashboardDir: string;
  /** A source checkout (has `src/`), as opposed to an installed package, which ships only the build output. */
  checkout: boolean;
}

/** No Lasso package.json above the starting directory: the files Lasso runs from are not laid out as a package. */
export class PackageRootNotFound extends Error {
  constructor(from: string) {
    super(`cannot find Lasso's package.json (name ${PACKAGE_NAME}) in ${from} or any directory above it`);
  }
}

/** Walk up from `from` (by default this module's directory: src/ from source, dist/ from the bundle) to Lasso's package.json. */
export function findPackageRoot(from: string = import.meta.dirname): PackageRoot {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const version = lassoVersion(path.join(dir, "package.json"));
    if (version !== null) return { root: dir, version, dashboardDir: path.join(dir, "dist", "dashboard"), checkout: existsSync(path.join(dir, "src")) };
    if (path.dirname(dir) === dir) throw new PackageRootNotFound(from);
  }
}

function lassoVersion(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === PACKAGE_NAME && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
