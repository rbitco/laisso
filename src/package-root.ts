import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Laisso's own package name; a package.json with any other name is someone else's and the walk goes on past it. */
export const PACKAGE_NAME = "@rbitco/laisso";

/** Where Laisso's own files are: the same answer from a source checkout and from an installed bundle in any prefix. */
export interface PackageRoot {
  /** The directory holding Laisso's package.json. */
  root: string;
  version: string;
  /** Where `pnpm build` writes the dashboard (ADR 0012); shipped in the package, not committed. */
  dashboardDir: string;
  /** The Laisso skill shipped in the package, which `laisso skill install` copies to where agents look. */
  skillDir: string;
  /** A source checkout (has `src/`), as opposed to an installed package, which ships only the build output. */
  checkout: boolean;
}

/** No Laisso package.json above the starting directory: the files Laisso runs from are not laid out as a package. */
export class PackageRootNotFound extends Error {
  constructor(from: string) {
    super(`cannot find Laisso's package.json (name ${PACKAGE_NAME}) in ${from} or any directory above it`);
  }
}

/** Walk up from `from` (by default this module's directory: src/ from source, dist/ from the bundle) to Laisso's package.json. */
export function findPackageRoot(from: string = import.meta.dirname): PackageRoot {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const version = laissoVersion(path.join(dir, "package.json"));
    if (version !== null) return { root: dir, version, dashboardDir: path.join(dir, "dist", "dashboard"), skillDir: path.join(dir, "skills", "laisso"), checkout: existsSync(path.join(dir, "src")) };
    if (path.dirname(dir) === dir) throw new PackageRootNotFound(from);
  }
}

function laissoVersion(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === PACKAGE_NAME && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
