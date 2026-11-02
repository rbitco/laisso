import { StringDecoder } from "node:string_decoder";

/**
 * Follows one Session's stdout as it streams and keeps its Latest Message: the newest
 * line `read` finds the agent's words in. Chunks split lines and characters anywhere, so
 * a partial last line is held until its newline comes, or until `flush` at the end.
 */
/** An Action's reader: any line with something on it, trimmed, so the last non-empty line wins. */
export const actionLine = (line: string): string | null => line.trim() || null;

export class LatestMessageTracker {
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private latest: string | null = null;
  private read: (line: string) => string | null;

  constructor(read: (line: string) => string | null) {
    this.read = read;
  }

  /** Takes a chunk of stdout; returns the Latest Message when this chunk changed it, else null. */
  feed(chunk: Buffer | string): string | null {
    const text = this.partial + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    const lines = text.split("\n");
    this.partial = lines.pop()!;
    return this.take(lines);
  }

  /** Reads the line still held when stdout ends without a newline; returns the Latest Message if it changed. */
  flush(): string | null {
    const rest = this.partial + this.decoder.end();
    this.partial = "";
    return this.take([rest]);
  }

  private take(lines: string[]): string | null {
    let found: string | null = null;
    for (const line of lines) {
      const message = line.trim() ? this.read(line.replace(/\r$/, "")) : null;
      if (message !== null) found = message;
    }
    if (found === null || found === this.latest) return null;
    this.latest = found;
    return found;
  }
}
