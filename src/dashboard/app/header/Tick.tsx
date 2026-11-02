import { useEffect, useReducer, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TickResult, TickStatus } from "../../../server/tick.ts";
import { tickIndicator } from "../../metro.ts";
import { api } from "../api.ts";
import { useClock } from "../clock.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { message } from "../ticket/ticket.ts";

/** "connecting" until the first status or error, "down" while Laisso is unreachable, else the last Tick status sent. */
type Seen = TickStatus | "down" | "connecting";

/** One cycle of the pulse animation, from the page's --pulse. */
function pulseMs(): number {
  const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pulse")) * 1000;
  return Number.isFinite(ms) ? ms : 1400;
}

/**
 * The nav's status dot: green while Laisso is connected and ticking on time (pulsing while a Tick runs), orange when a
 * Tick is overdue, grey while Laisso is unreachable or not yet heard from. Clicking it opens a popover saying so in
 * words, when the last Tick ran and the next is due (moving each second), and Check now. `onChecked` follows a Check
 * now, so the page reads again.
 */
export function Tick({ onChecked }: { onChecked: () => void }) {
  const [seen, setSeen] = useState<Seen>("connecting");
  const last = useRef<Seen>("connecting");
  // A running Tick pulses the dot for at least one full cycle of the pulse animation, so a fast one still shows.
  // The tooltip follows the status at once and does not wait for the hold.
  const [pulseUntil, setPulseUntil] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
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
  const held = (drawn?.state === "healthy" || drawn?.state === "late") && now < pulseUntil;
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(redraw, pulseUntil - Date.now());
    return () => clearTimeout(timer);
  }, [held, pulseUntil]);

  // A click outside the popover or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const away = (ev: PointerEvent) => {
      if (!box.current?.contains(ev.target as Node)) setOpen(false);
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

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

  const state = drawn ? (held ? "running" : drawn.state) : "connecting";
  const label = drawn?.label ?? "Connecting";
  return (
    <div className="tick" ref={box}>
      <button type="button" className="tick-toggle" data-role="tick-toggle" aria-expanded={open} aria-controls="tick-pop" aria-label={"Laisso status: " + label} title={"Laisso status: " + label} onClick={() => setOpen((o) => !o)}>
        <span className={"dot tick-dot " + state} data-role="tick-dot" aria-hidden="true" />
      </button>
      {open && (
        <div className={"tick-pop " + state} id="tick-pop" role="dialog" aria-label="Laisso status" data-role="tick-pop">
          <div className="tick-head">
            <span className={"dot tick-dot " + state} aria-hidden="true" />
            <strong data-role="tick-label">{label}</strong>
          </div>
          <div className="tick-status" data-role="tick-status">
            {drawn?.detail ?? "Waiting for Laisso to answer"}
          </div>
          <button type="button" data-role="check-now" disabled={!drawn || drawn.state === "down"} onClick={check}>
            <RefreshCw aria-hidden="true" />
            <span>Check now</span>
          </button>
        </div>
      )}
    </div>
  );
}
