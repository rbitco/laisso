import { writeFileSync, renameSync } from "node:fs";

/** Replace a file's contents in one step: written beside it first, then renamed over it, so a crash mid-write leaves the old file whole. */
export function replaceFile(file: string, text: string): void {
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, text);
  renameSync(draft, file);
}
