import { createClient } from "./client.ts";
import type { TicketView, TicketDetail } from "../api/views.ts";

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
    `repo:      ${t.repo}`,
    `branch:    ${t.branch}`,
    `worktree:  ${t.worktree}`,
    `pipeline:  ${t.pipeline}`,
    `stage:     ${t.stage.label} (${t.stage.index + 1} of ${t.stage.total})`,
    `pr:        ${t.pr ?? "none"}`,
    `url:       ${t.url}`,
    "",
    "stages:",
    ...t.stages.map((s, i) => `  ${i === t.stage.index ? ">" : " "} ${s.label}${s.human ? " (human)" : ""}`),
  ];
  if (t.flag) lines.splice(2, 0, `flag:      ${t.flag.reason}${t.flag.detail ? `: ${t.flag.detail}` : ""}`);
  return lines.join("\n");
}
