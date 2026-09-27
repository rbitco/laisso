import { createClient } from "./client.ts";
import type { TicketView, TicketDetail, SessionView } from "../api/views.ts";

export interface StatusOptions {
  portFlag?: number;
  json: boolean;
  all: boolean;
  ticket?: string;
}

export async function status(opts: StatusOptions): Promise<number> {
  const client = createClient(opts.portFlag);
  try {
    if (opts.ticket) {
      const detail = await client.get<TicketDetail>(`/api/tickets/${encodeURIComponent(opts.ticket)}`);
      console.log(opts.json ? JSON.stringify(detail, null, 2) : renderDetail(detail));
      return 0;
    }
    const tickets = await client.get<TicketView[]>(`/api/tickets${opts.all ? "?all=1" : ""}`);
    if (opts.json) console.log(JSON.stringify({ tickets }, null, 2));
    else console.log(tickets.length ? renderLedger(tickets) : "no active Tickets");
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function renderLedger(tickets: TicketView[]): string {
  const rows = tickets.map((t) => [t.display.label, t.reference ?? t.shortId, t.repo, t.stage.label, t.title, t.display.why]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function renderDetail(t: TicketDetail): string {
  const lines = [
    `${t.reference ?? t.id}  ${t.title}`,
    `state:     ${t.display.label} (${t.display.why})`,
    ...(t.triggers.length ? [`levers:    ${t.triggers.map((x) => x.label).join(" · ")}`] : []),
    `repo:      ${t.repo}`,
    `branch:    ${t.branch}`,
    `worktree:  ${t.worktree}`,
    `pipeline:  ${t.pipeline}`,
    `stage:     ${t.stage.label} (${t.stage.index + 1} of ${t.stage.total})`,
    `pr:        ${t.pr ?? "none"}`,
    `budget:    ${budgetLine(t)}`,
    `url:       ${t.url}`,
    "",
    "stages:",
    ...t.stages.map((s, i) => `  ${i === t.stage.index ? ">" : " "} ${s.label}${s.human ? " (human)" : ""}`),
  ];
  if (t.flag) lines.splice(2, 0, `flag:      ${t.flag.reason}${t.flag.detail ? `: ${t.flag.detail}` : ""}`);
  if (t.mirrorPending) lines.splice(2, 0, "tracker:   labels not written yet; retried each tick");
  if (t.session) {
    if (t.session.finalMessage) lines.push(`last:      ${t.session.finalMessage.split("\n")[0]}`);
    if (t.session.stdoutPath) lines.push(`stdout:    ${t.session.stdoutPath}`);
    if (t.session.transcriptPath) lines.push(`transcript: ${t.session.transcriptPath}`);
  }
  if (t.sessions.length) lines.push("", "sessions:", ...t.sessions.map((s) => `  ${sessionLine(s)}`));
  return lines.join("\n");
}

/** The four gauges in words; a starred one is set on the Ticket itself. */
function budgetLine(t: TicketView): string {
  const b = t.budget;
  const star = (source: string) => (source === "ticket" ? "*" : "");
  return [
    `rounds ${b.rounds.used}/${b.rounds.limit}${star(b.rounds.source)}`,
    `attempts ${b.attempts.used}/${b.attempts.limit}${star(b.attempts.source)}`,
    `wall ${duration(b.wallTime.used)}/${b.wallTime.limitText}${star(b.wallTime.source)}`,
    `spend $${b.spend.used.toFixed(2)}/$${b.spend.limit}${star(b.spend.source)}`,
  ].join(" · ");
}

/** One line per Session: Stage and attempt, how it ended, how long, what it cost. */
function sessionLine(s: SessionView): string {
  const ended = s.running ? "running" : `${s.outcome ?? "?"}${s.endedReason ? ` (${s.endedReason})` : ""}`;
  const cost = s.costUsd === null ? "" : `  $${s.costUsd.toFixed(2)}`;
  return `${s.stage} #${s.ordinal}  ${s.mode}  ${ended}  ${duration(s.durationMs)}${cost}  ${s.startedAt}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}
