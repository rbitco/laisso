import { execFile } from "node:child_process";
import type { NotificationConfig } from "../server/config.ts";
import type { Logger } from "../server/log.ts";
import type { TicketRow } from "../store/tickets.ts";
import { appleString, shellQuote } from "../macos.ts";

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

/** macOS only for v1, like Terminal: terminal-notifier when on PATH (click shows the Ticket), else osascript. */
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
      postOnMacos(title, body, showTicket(deps.baseUrl, url), done);
    },
  };
}

/**
 * The shell line a click runs: point a Chrome tab already on the dashboard at the Ticket and bring it forward
 * (the dashboard follows its hash, so it does not reload), else open the URL in the default browser.
 * terminal-notifier's own -open always asks for a new tab.
 */
export function showTicket(baseUrl: string, url: string): string {
  const script = `if application "Google Chrome" is not running then error "no Chrome"
tell application "Google Chrome"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      set u to URL of t
      if u is ${appleString(baseUrl)} or u starts with ${appleString(`${baseUrl}/`)} then
        set URL of t to ${appleString(url)}
        set active tab index of w to i
        set index of w to 1
        activate
        return
      end if
    end repeat
  end repeat
end tell
error "no dashboard tab"`;
  return `osascript -e ${shellQuote(script)} || open ${shellQuote(url)}`;
}

function postOnMacos(title: string, body: string, click: string, done: (adapter: string, error: Error | null) => void): void {
  execFile("terminal-notifier", ["-title", title, "-message", body, "-execute", click], (error) => {
    if (!error) return done("terminal-notifier", null);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return done("terminal-notifier", error);
    const script = `display notification ${appleString(body)} with title ${appleString(title)}`;
    execFile("osascript", ["-e", script], (fallbackError) => done("osascript", fallbackError));
  });
}
