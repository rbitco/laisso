import type { TicketView } from "../api/views.ts";
import type { TickStatus } from "../server/tick.ts";
import { renderBoard, renderLogLine } from "./board.ts";
import type { LogFeed } from "./feed.ts";
import type { Colour } from "./paint.ts";

export interface ScreenInput {
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  off(event: "data", listener: (data: Buffer | string) => void): unknown;
  setRawMode(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface ScreenOutput {
  write(text: string): unknown;
  columns: number;
  rows: number;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface ScreenDeps {
  input: ScreenInput;
  output: ScreenOutput;
  feed: LogFeed;
  colour: Colour;
  version: string;
  url: string;
  home: string;
  /** The active Tickets in Ledger order and the Tick's status, read the way the dashboard reads them. */
  tickets(): Promise<TicketView[]>;
  tick(): Promise<TickStatus>;
  /** Called on every change the dashboard would hear of; returns the unsubscribe. */
  subscribe(changed: () => void): () => void;
  /** Shut Laisso down, as Ctrl-C does. The screen stops itself first. */
  quit(): void;
  /** Open the dashboard in a browser. */
  open(url: string): void;
  now?: () => number;
}

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** How long a burst of changes is gathered before the board reads again. */
const SETTLE_MS = 150;

/**
 * The terminal while `laisso` runs: a board on the alternate screen with the logo, Ticket counts, the Tick and the
 * Tickets that need you, redrawn as things change. l swaps to the log, streamed on the normal screen so the
 * terminal's own scrollback and copying work; l or Esc swaps back. q quits, asking first when Sessions are running.
 */
export class Screen {
  private view: "board" | "logs" = "board";
  private tickets: TicketView[] | null = null;
  private tickStatus: TickStatus | null = null;
  private confirmQuit: number | null = null;
  /** Log lines that arrived while the board was up, written when the log is next shown; null until it first is. */
  private unseen: string[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: () => void = () => undefined;
  private stopped = false;
  private now: () => number;
  private deps: ScreenDeps;

  constructor(deps: ScreenDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const { input, output, feed } = this.deps;
    feed.hold();
    output.write(ENTER_ALT + HIDE_CURSOR);
    input.setRawMode(true);
    input.resume();
    input.on("data", this.onKey);
    output.on("resize", this.draw);
    feed.listen((line) => {
      if (this.view === "logs") output.write(renderLogLine(line, this.deps.colour) + "\n");
      else if (this.unseen) this.unseen.push(line);
    });
    this.unsubscribe = this.deps.subscribe(() => this.refreshSoon());
    // The Tick line counts seconds, so the board redraws each second even when nothing changes.
    this.timer = setInterval(() => this.view === "board" && this.draw(), 1000);
    this.timer.unref?.();
    this.draw();
    void this.refresh();
  }

  /** Give the terminal back as it was found; the log goes on as plain lines. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const { input, output, feed } = this.deps;
    if (this.timer) clearInterval(this.timer);
    if (this.settle) clearTimeout(this.settle);
    this.unsubscribe();
    input.off("data", this.onKey);
    output.off("resize", this.draw);
    input.setRawMode(false);
    input.pause();
    if (this.view === "board") output.write(LEAVE_ALT);
    output.write(SHOW_CURSOR);
    feed.passThrough();
  }

  private onKey = (data: Buffer | string): void => {
    const key = data.toString();
    if (key === "\x03") return this.quitNow();
    if (this.confirmQuit !== null) {
      this.confirmQuit = null;
      if (key === "y" || key === "Y") return this.quitNow();
      return this.draw();
    }
    if (key === "l" || key === "L") return this.view === "board" ? this.showLogs() : this.showBoard();
    if (key === "\x1b" && this.view === "logs") return this.showBoard();
    if (key === "o" || key === "O") return this.deps.open(this.deps.url);
    if (key === "q" || key === "Q") {
      const running = (this.tickets ?? []).filter((t) => t.display.state === "running").length;
      if (running === 0) return this.quitNow();
      this.confirmQuit = running;
      return this.view === "board" ? this.draw() : this.showBoard();
    }
  };

  private quitNow(): void {
    this.stop();
    this.deps.quit();
  }

  private showLogs(): void {
    const { output, feed, colour } = this.deps;
    this.view = "logs";
    output.write(LEAVE_ALT + SHOW_CURSOR);
    const lines = this.unseen ?? feed.recent();
    this.unseen = [];
    output.write(`\n── logs · l or Esc for the board ──\n`);
    for (const line of lines) output.write(renderLogLine(line, colour) + "\n");
  }

  private showBoard(): void {
    this.view = "board";
    this.deps.output.write(ENTER_ALT + HIDE_CURSOR);
    this.draw();
  }

  private refreshSoon(): void {
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      void this.refresh();
    }, SETTLE_MS);
  }

  private async refresh(): Promise<void> {
    try {
      [this.tickets, this.tickStatus] = await Promise.all([this.deps.tickets(), this.deps.tick()]);
    } catch {
      // A failed read leaves the last one on screen; the next change or second tries again.
      return;
    }
    if (!this.stopped && this.view === "board") this.draw();
  }

  private draw = (): void => {
    if (this.stopped || this.view !== "board") return;
    const { output } = this.deps;
    const lines = renderBoard({
      version: this.deps.version,
      url: this.deps.url,
      home: this.deps.home,
      tickets: this.tickets,
      tick: this.tickStatus,
      now: this.now(),
      width: Math.max(20, output.columns || 80),
      height: Math.max(12, output.rows || 24),
      colour: this.deps.colour,
      confirmQuit: this.confirmQuit,
    });
    // Home, each line cleared to its end, then everything below cleared: no flicker, no leftovers from a longer frame.
    output.write("\x1b[H" + lines.map((line) => line + "\x1b[K").join("\n") + "\x1b[J");
  };
}
