/** How many recent log lines the feed keeps for the logs view; the log file keeps them all. */
const KEEP = 500;

/**
 * Where the logger's screen copy goes. Passing through (until the board holds it, and again once the board lets go),
 * each line is written to `out` as a plain log would; held, lines are kept (the last 500) and handed to whoever
 * listens, so the board can own the screen while the log carries on.
 */
export class LogFeed {
  private lines: string[] = [];
  private listener: ((line: string) => void) | null = null;
  private passing = true;
  private out: { write(text: string): unknown };

  constructor(out: { write(text: string): unknown }) {
    this.out = out;
  }

  write(line: string): void {
    if (this.passing) {
      this.out.write(line);
      return;
    }
    this.lines.push(line);
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
    this.listener?.(line);
  }

  /** The lines kept so far, oldest first. */
  recent(): string[] {
    return [...this.lines];
  }

  /** Hand each new line to `listener` as well as keeping it; null stops. */
  listen(listener: ((line: string) => void) | null): void {
    this.listener = listener;
  }

  /** Keep lines instead of writing them: the board has the screen. */
  hold(): void {
    this.passing = false;
  }

  /** From now on every line goes straight to `out`, as a plain log would: the board has let go of the screen. */
  passThrough(): void {
    this.passing = true;
    this.listener = null;
  }
}
