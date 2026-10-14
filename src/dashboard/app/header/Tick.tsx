import { useEffect, useReducer, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TickResult, TickStatus } from "../../../server/tick.ts";
import { tickIndicator } from "../../metro.ts";
import { api } from "../api.ts";
import { useClock } from "../clock.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { message } from "../ticket/ticket.ts";

/** "connecting" until the first status or error, "down" while Lasso is unreachable, else the last Tick status sent. */
type Seen = TickStatus | "down" | "connecting";

/** One cycle of the pulse animation, from the page's --pulse. */
function pulseMs(): number {
  const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pulse")) * 1000;
  return Number.isFinite(ms) ? ms : 1400;
}

/**
 * The nav's Tick dot, its status, and Check now. The dot is still when idle, pulses while a Tick runs, and is red and
 * still while Lasso is unreachable; the status beside it, and its tooltip, say when the last Tick ran and the next is
 * due, and move each second. Until the first status or error neither shows. `onChecked` follows a Check now, so the page reads again.
 */
export function Tick({ onChecked }: { onChecked: () => void }) {
  const [seen, setSeen] = useState<Seen>("connecting");
  const last = useRef<Seen>("connecting");
  // A running Tick pulses the dot for at least one full cycle of the pulse animation, so a fast one still shows.
  // The tooltip follows the status at once and does not wait for the hold.
  const [pulseUntil, setPulseUntil] = useState(0);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useClock();

  const pulse = () => setPulseUntil((until) => Math.max(until, Date.now() + pulseMs()));
  const show = (status: TickStatus) => {
    // /api/events gathers changes briefly, so a fast Tick can arrive already ended; a newer lastTick than a
    // still status means one ran unseen. A Tick seen running has had its pulse.
    const prev = typeof last.current === "object" ? last.current : null;
    last.current = status;
    setSeen(status);
    if (status.running || (prev && !prev.running && status.lastTick !== prev.lastTick)) pulse();
  };
  const lost = () => {
    last.current = "down";
    setSeen("down");
  };
  useEvents(["hello", "tick"], (event) => show(JSON.parse(event.data)));
  useEvents(["error"], lost);

  const now = Date.now();
  const drawn = seen === "connecting" ? null : tickIndicator(seen, now);
  const held = drawn?.state === "idle" && now < pulseUntil;
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(redraw, pulseUntil - Date.now());
    return () => clearTimeout(timer);
  }, [held, pulseUntil]);

  const check = async () => {
    // The click shows at once rather than waiting on the server's tick event.
    if (typeof last.current === "object") pulse();
    try {
      const tick = await api<TickResult>("/api/check-now", { method: "POST" });
      showNotice(tick.changes.length ? tick.changes.map((c) => c.summary).join("; ") : "nothing new");
      try {
        show(await api<TickStatus>("/api/tick"));
      } catch {
        lost();
      }
      onChecked();
    } catch (error) {
      showNotice(message(error));
    }
  };

  return (
    <div className="tick">
      <div className="tick-line">
        <span className={"dot tick-dot" + (drawn ? " " + (held ? "running" : drawn.state) : "")} data-role="tick-dot" role="img" title={drawn?.title} aria-label={drawn?.title} />
        <span className="tick-status" data-role="tick-status" aria-hidden="true">
          {drawn?.title}
        </span>
      </div>
      <button type="button" data-role="check-now" title="Check now" onClick={check}>
        <RefreshCw aria-hidden="true" />
        <span className="label">Check now</span>
      </button>
    </div>
  );
}
