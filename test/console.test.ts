import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { DisplayState, TicketView } from "../src/api/views.ts";
import type { TickStatus } from "../src/server/tick.ts";
import { renderBoard, renderLogLine, fit, type BoardInput } from "../src/console/board.ts";
import { logo } from "../src/console/logo.ts";
import { colourOf, visibleLength } from "../src/console/paint.ts";
import { LogFeed } from "../src/console/feed.ts";
import { Screen, type ScreenDeps } from "../src/console/screen.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");

function ticket(label: string, state: DisplayState, title = `${label} title`): TicketView {
  return { label, title, display: { state, label: state === "needs_you" ? "Needs you" : state[0]!.toUpperCase() + state.slice(1), why: "" } } as TicketView;
}

const tick: TickStatus = { tickSeconds: 60, lastTick: "2026-11-11T11:59:48Z", nextTick: "2026-11-11T12:00:48Z", running: false };

function board(over: Partial<BoardInput> = {}): string[] {
  return renderBoard({ version: "1.2.3", url: "http://localhost:7433", home: "/h/.laisso", tickets: [], tick, now: NOW, width: 80, height: 24, colour: "none", confirmQuit: null, ...over });
}

// The terminal while laisso runs: a board with the logo and the Ticket counts, and the log a key away.
describe("the console board", () => {
  it("draws the logo as six lines of half blocks with the three dots", () => {
    const lines = logo("none");
    expect(lines).toHaveLength(6);
    expect(lines[2]).toBe("█   •  •  •  █");
    expect(new Set(lines.map((l) => l.length))).toEqual(new Set([14]));
  });

  it("puts the name, version and URL beside the logo", () => {
    const lines = board();
    expect(lines[1]).toContain("L A I S S O  1.2.3");
    expect(lines[2]).toContain("http://localhost:7433");
  });

  it("counts the active Tickets by state, in Ledger order, leaving out states with none", () => {
    const lines = board({ tickets: [ticket("A-1", "flagged"), ticket("A-2", "needs_you"), ticket("A-3", "needs_you"), ticket("A-4", "running"), ticket("A-5", "quiet")] });
    expect(lines).toContain("  Tickets   5 active");
    expect(lines).toContain("            1 flagged · 2 need you · 1 running · 1 quiet");
  });

  it("says when the last Tick ran and when the next is due", () => {
    expect(board()).toContain("  Tick      ● 12s ago, next in 48s");
    expect(board({ tick: { ...tick, running: true } })).toContain("  Tick      ● ticking now");
  });

  it("lists the Tickets that need you, and how many more when the screen is short", () => {
    const needs = [ticket("A-1", "flagged", "Fix the build"), ticket("A-2", "needs_you"), ticket("A-3", "needs_you"), ticket("A-4", "running")];
    expect(board({ tickets: needs })).toContain("  Flagged   A-1  Fix the build");
    expect(board({ tickets: needs }).filter((l) => l.includes("A-4"))).toEqual([]);
    const short = board({ tickets: needs, height: 16 });
    expect(short).toHaveLength(16);
    expect(short).toContain("  and 2 more on the dashboard");
  });

  it("fills the screen exactly, with the keys on the last line, or the quit question while it waits", () => {
    const lines = board();
    expect(lines).toHaveLength(24);
    expect(lines[23]).toBe("  l logs   o open dashboard   q quit");
    expect(board({ confirmQuit: 2 })[23]).toBe("  Stop 2 running Sessions and quit?  y / n");
  });

  it("never draws wider than the terminal, cutting coloured lines without bleeding colour", () => {
    for (const line of board({ width: 30, colour: "truecolor", tickets: [ticket("A-1", "needs_you", "a very long title ".repeat(5))] })) expect(visibleLength(line)).toBeLessThanOrEqual(30);
    expect(fit("\x1b[2mabcdefgh\x1b[0m", 5)).toBe("\x1b[2mabcd…\x1b[0m");
  });

  it("shows a log line with a clock time and its level", () => {
    const line = renderLogLine("2026-11-11T12:00:00.000Z WARN review.poll status=403\n", "none");
    expect(line).toMatch(/^\d\d:\d\d:\d\d WARN  review\.poll status=403$/);
    expect(renderLogLine("not a log line\n", "none")).toBe("not a log line");
  });

  it("takes its colour depth from the environment, NO_COLOR first", () => {
    expect(colourOf({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colourOf({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colourOf({ TERM: "xterm-256color" })).toBe("256");
    expect(colourOf({ TERM: "dumb" })).toBe("none");
  });
});

describe("the log feed", () => {
  it("passes lines through until held, keeps them while held, and passes through again once let go", () => {
    const out: string[] = [];
    const feed = new LogFeed({ write: (t) => out.push(t) });
    feed.write("a\n");
    feed.hold();
    const heard: string[] = [];
    feed.listen((l) => heard.push(l));
    feed.write("b\n");
    expect(out).toEqual(["a\n"]);
    expect(feed.recent()).toEqual(["b\n"]);
    expect(heard).toEqual(["b\n"]);
    feed.passThrough();
    feed.write("c\n");
    expect(out).toEqual(["a\n", "c\n"]);
    expect(heard).toEqual(["b\n"]);
  });
});

class FakeTerminal extends EventEmitter {
  written = "";
  raw = false;
  columns = 80;
  rows = 24;
  write(text: string) {
    this.written += text;
    return true;
  }
  setRawMode(raw: boolean) {
    this.raw = raw;
  }
  resume() {}
  pause() {}
  press(key: string) {
    this.emit("data", Buffer.from(key));
  }
}

async function screenWith(tickets: TicketView[]) {
  const term = new FakeTerminal();
  const out: string[] = [];
  const feed = new LogFeed({ write: (t) => out.push(t) });
  let changed: () => void = () => undefined;
  const quit = vi.fn();
  const open = vi.fn();
  const deps: ScreenDeps = { input: term, output: term, feed, colour: "none", version: "1.2.3", url: "http://localhost:7433", home: "/h", tickets: async () => tickets, tick: async () => tick, subscribe: (c) => ((changed = c), () => undefined), quit, open, now: () => NOW };
  const screen = new Screen(deps);
  screen.start();
  await vi.waitFor(() => expect(term.written).toContain("Tickets   "));
  return { term, feed, out, screen, quit, open, changed: () => changed() };
}

describe("the console screen", () => {
  it("takes the alternate screen in raw mode, and gives both back when stopped", async () => {
    const { term, screen } = await screenWith([]);
    expect(term.written.startsWith("\x1b[?1049h\x1b[?25l")).toBe(true);
    expect(term.raw).toBe(true);
    screen.stop();
    expect(term.raw).toBe(false);
    expect(term.written.endsWith("\x1b[?1049l\x1b[?25h")).toBe(true);
  });

  it("l shows the log so far on the normal screen, streams new lines, and l goes back to the board", async () => {
    const { term, feed } = await screenWith([]);
    feed.write("2026-11-11T12:00:00.000Z INFO started port=7433\n");
    term.written = "";
    term.press("l");
    expect(term.written).toMatch(/^\x1b\[\?1049l\x1b\[\?25h\n── logs · l or Esc for the board ──\n\d\d:\d\d:\d\d INFO  started port=7433\n$/);
    term.written = "";
    feed.write("2026-11-11T12:00:01.000Z ERROR boom\n");
    expect(term.written).toMatch(/ERROR boom\n$/);
    term.press("l");
    expect(term.written).toContain("\x1b[?1049h");
    expect(term.written).toContain("l logs");
  });

  it("shows only the lines that came while the board was up when the log is shown again", async () => {
    const { term, feed } = await screenWith([]);
    feed.write("2026-11-11T12:00:00.000Z INFO one\n");
    term.press("l");
    term.press("\x1b");
    feed.write("2026-11-11T12:00:01.000Z INFO two\n");
    term.written = "";
    term.press("l");
    expect(term.written).toContain("two");
    expect(term.written).not.toContain("one");
  });

  it("q quits at once when nothing runs", async () => {
    const { term, quit } = await screenWith([ticket("A-1", "quiet")]);
    term.press("q");
    expect(quit).toHaveBeenCalledOnce();
    expect(term.raw).toBe(false);
  });

  it("q asks first while Sessions run: y quits, anything else carries on", async () => {
    const { term, quit } = await screenWith([ticket("A-1", "running"), ticket("A-2", "running")]);
    term.press("q");
    expect(term.written).toContain("Stop 2 running Sessions and quit?");
    term.press("n");
    expect(quit).not.toHaveBeenCalled();
    term.press("q");
    term.press("y");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("Ctrl-C quits at once, running Sessions or not", async () => {
    const { term, quit } = await screenWith([ticket("A-1", "running")]);
    term.press("\x03");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("o opens the dashboard", async () => {
    const { term, open } = await screenWith([]);
    term.press("o");
    expect(open).toHaveBeenCalledWith("http://localhost:7433");
  });

  it("reads again after a change and redraws with the new counts", async () => {
    const tickets = [ticket("A-1", "quiet")];
    const { term, changed } = await screenWith(tickets);
    tickets.push(ticket("A-2", "needs_you"));
    term.written = "";
    changed();
    await vi.waitFor(() => expect(term.written).toContain("1 need you"));
  });
});
