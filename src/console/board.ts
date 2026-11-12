import type { DisplayState, TicketView } from "../api/views.ts";
import type { TickStatus } from "../server/tick.ts";
import { logo } from "./logo.ts";
import { paint, visibleLength, type Colour } from "./paint.ts";

/** The colours the board borrows from the dashboard's dark theme. */
const AMBER: [number, number, number] = [0xe8, 0xad, 0x52];
const CRIT: [number, number, number] = [0xef, 0x5b, 0x4c];
const GOOD: [number, number, number] = [0x6f, 0xc9, 0x85];
const RUN: [number, number, number] = [0x7a, 0xa6, 0xe8];
const WAIT: [number, number, number] = [0xb0, 0x9a, 0xe6];

/** The states that ask something of the human, as the dashboard's nav counts them. */
export const NEEDS_YOU: DisplayState[] = ["flagged", "needs_you"];

/** The count line's order and colours; a state with no Tickets is left out. Done and Abandoned are never listed. */
const COUNTED: Array<{ state: DisplayState; words: string; rgb?: [number, number, number] }> = [
  { state: "flagged", words: "flagged", rgb: CRIT },
  { state: "needs_you", words: "need you", rgb: AMBER },
  { state: "holding", words: "holding" },
  { state: "ready", words: "ready to start" },
  { state: "running", words: "running", rgb: RUN },
  { state: "queued", words: "queued" },
  { state: "watching", words: "watching", rgb: WAIT },
  { state: "quiet", words: "quiet", rgb: GOOD },
];

export interface BoardInput {
  version: string;
  url: string;
  home: string;
  /** The active Tickets as /api/tickets serves them, already in Ledger order; null until the first read lands. */
  tickets: TicketView[] | null;
  tick: TickStatus | null;
  now: number;
  width: number;
  height: number;
  colour: Colour;
  /** Set while q waits for a yes: how many Sessions quitting would stop. */
  confirmQuit: number | null;
}

/** The board's lines: the logo beside the name, version and URL; the Ticket counts; the Tick; the Tickets that need you; the keys. */
export function renderBoard(input: BoardInput): string[] {
  const { colour, width } = input;
  const dim = (text: string) => paint(colour, text, { dim: true });
  const side = [paint(colour, "L A I S S O", { bold: true }) + "  " + dim(input.version), input.url, dim(shortHome(input.home))];
  const lines = logo(colour).map((row, i) => "  " + row + (side[i - 1] ? "    " + side[i - 1] : ""));
  lines.push("");

  const tickets = input.tickets;
  if (tickets === null) lines.push("  " + dim("Reading Tickets…"));
  else {
    lines.push("  " + label("Tickets", colour) + (tickets.length ? `${tickets.length} active` : dim("none active")));
    const counts = COUNTED.map(({ state, words, rgb }) => ({ n: tickets.filter((t) => t.display.state === state).length, words, rgb })).filter((c) => c.n > 0);
    if (counts.length) lines.push("  " + " ".repeat(LABEL) + counts.map((c) => paint(colour, `${c.n} ${c.words}`, { rgb: c.rgb })).join(dim(" · ")));
  }
  lines.push("  " + label("Tick", colour) + tickLine(input.tick, input.now, colour));

  const needs = (tickets ?? []).filter((t) => NEEDS_YOU.includes(t.display.state));
  const footer = 2;
  const room = input.height - lines.length - footer - 2;
  if (needs.length && room > 0) {
    lines.push("");
    lines.push("  " + paint(colour, "Needs you", { bold: true }));
    const shown = needs.length > room ? needs.slice(0, room - 1) : needs;
    for (const t of shown) {
      const state = paint(colour, t.display.label.padEnd(10), { rgb: t.display.state === "flagged" ? CRIT : AMBER });
      lines.push(fit(`  ${state}${t.label}  ${dim(t.title)}`, width));
    }
    if (shown.length < needs.length) lines.push("  " + dim(`and ${needs.length - shown.length} more on the dashboard`));
  }

  // The body fills the screen above the footer, cut when the terminal is too short, so the footer stays at the bottom.
  const body = lines.slice(0, input.height - footer);
  while (body.length < input.height - footer) body.push("");
  body.push("");
  body.push(input.confirmQuit !== null ? "  " + paint(colour, `Stop ${input.confirmQuit} running Session${input.confirmQuit === 1 ? "" : "s"} and quit?`, { rgb: AMBER, bold: true }) + "  y / n" : "  " + keys(colour));
  return body.map((line) => fit(line, width));
}

/** The width the board's row labels are padded to. */
const LABEL = 10;

function label(text: string, colour: Colour): string {
  return paint(colour, text.padEnd(LABEL), { dim: true });
}

function keys(colour: Colour): string {
  const key = (k: string, what: string) => paint(colour, k, { bold: true }) + " " + paint(colour, what, { dim: true });
  return [key("l", "logs"), key("o", "open dashboard"), key("q", "quit")].join("   ");
}

/** When the last Tick ran and when the next is due, as the dashboard's status dot says it. */
function tickLine(tick: TickStatus | null, now: number, colour: Colour): string {
  if (!tick) return paint(colour, "starting", { dim: true });
  const dot = paint(colour, "●", { rgb: tick.running ? RUN : GOOD });
  if (tick.running) return `${dot} ticking now`;
  const last = tick.lastTick ? `${ago(now - Date.parse(tick.lastTick))} ago` : "not yet";
  const next = tick.nextTick ? `, next in ${ago(Math.max(0, Date.parse(tick.nextTick) - now))}` : "";
  return `${dot} ${last}${next}`;
}

/** A span in its largest whole unit: 12s, 4m, 3h. */
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function shortHome(home: string): string {
  const user = process.env.HOME;
  return user && home.startsWith(user + "/") ? "~" + home.slice(user.length) : home;
}

/**
 * `line` cut to `width` columns, escapes kept whole, with an ellipsis where it was cut. A cut inside a coloured run
 * ends with a reset, so the colour never bleeds into the next line.
 */
export function fit(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  let out = "";
  let shown = 0;
  for (let i = 0; i < line.length && shown < width - 1; ) {
    const escape = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (escape) {
      out += escape[0];
      i += escape[0].length;
      continue;
    }
    out += line[i];
    shown++;
    i++;
  }
  return out + "…" + (out.includes("\x1b[") ? "\x1b[0m" : "");
}

/** A log line as the logger wrote it, shown with a local clock time and its level coloured. */
export function renderLogLine(line: string, colour: Colour): string {
  const match = /^(\S+) (INFO|WARN|ERROR) (.*)$/.exec(line.trimEnd());
  if (!match) return line.trimEnd();
  const [, at, level, rest] = match;
  const time = new Date(at!);
  const clock = Number.isNaN(time.getTime()) ? at! : time.toLocaleTimeString("en-GB", { hour12: false });
  const rgb = level === "ERROR" ? CRIT : level === "WARN" ? AMBER : undefined;
  return `${paint(colour, clock!, { dim: true })} ${paint(colour, level!.padEnd(5), level === "INFO" ? { dim: true } : { rgb, bold: true })} ${rest}`;
}
