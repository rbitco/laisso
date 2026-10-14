import { execFile } from "node:child_process";
import type { NotificationConfig } from "../server/config.ts";
import type { Logger } from "../server/log.ts";
import type { TicketRow } from "../store/tickets.ts";
import { appleString } from "../macos.ts";

export type NotifyEvent = "flagged" | "human" | "gate";

/** Posts one native notification per event through the OS adapter; failures are logged only. */
export interface Notifier {
  post(event: NotifyEvent, ticket: TicketRow, body: string): void;
}

export interface NotifierDeps {
  config: NotificationConfig;
  log: Logger;
  baseUrl: string;
}

/** macOS only for v1, like Terminal: terminal-notifier when on PATH (click opens the Ticket), else osascript. */
export function createNotifier(deps: NotifierDeps): Notifier {
  return {
    post(event, ticket, body) {
      if (!deps.config.enabled || !deps.config[event]) return;
      const title = ticket.name ?? (ticket.reference ? `${ticket.reference} ${ticket.title}` : ticket.title);
      const url = `${deps.baseUrl}/#${ticket.id}`;
      const done = (adapter: string, error: Error | null) => {
        if (error) deps.log.warn("notify.failed", { event, ticket: ticket.id, adapter, error: error.message });
        else deps.log.info("notify.posted", { event, ticket: ticket.id, adapter });
      };
      postOnMacos(title, body, url, done);
    },
  };
}

function postOnMacos(title: string, body: string, url: string, done: (adapter: string, error: Error | null) => void): void {
  execFile("terminal-notifier", ["-title", title, "-message", body, "-open", url], (error) => {
    if (!error) return done("terminal-notifier", null);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return done("terminal-notifier", error);
    const script = `display notification ${appleString(body)} with title ${appleString(title)}`;
    execFile("osascript", ["-e", script], (fallbackError) => done("osascript", fallbackError));
  });
}
