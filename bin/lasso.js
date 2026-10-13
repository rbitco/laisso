#!/usr/bin/env -S node --enable-source-maps
// The CLI entry, run from source by `pnpm start` and the bundle input for `pnpm bundle`. esbuild keeps this
// line, so the installed bundle starts with source maps on and its stack traces point at the .ts lines.
import { main } from "../src/cli/main.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
