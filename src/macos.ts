/** Quoting for the two macOS surfaces Lasso drives: AppleScript strings and the shell lines Terminal.app runs. */

export function appleString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
