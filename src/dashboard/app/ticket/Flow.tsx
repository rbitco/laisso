import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import { duration, metroDiagram, relative, sessionsForStage } from "../../metro.ts";
import { sessionLabel } from "./SessionPane.tsx";
import { SendPopover } from "./Send.tsx";

const LEGEND =
  "Filled stations are done, the ringed station is current, a stop sign is Flagged, ticks are action Stages. The orbit above a repeating Stage is PR feedback with Rounds used of Budget on its badge; a small orbit counts attempts. Click a station to filter Sessions; hover one to send the Ticket there.";

/** A station the pointer is over, and where its Send here sits within the panel. */
interface Hovered {
  stage: string;
  left: number;
  top: number;
}

/**
 * The Metro flow diagram in its panel; a station click selects that Stage, and a second click clears it. Hovering a
 * station offers Send here (LASSO-197), which opens the Send popover for it; the offer stays on the last station
 * hovered until the pointer leaves the panel.
 */
export function Flow({ ticket, focus, onFocus, refresh }: { ticket: TicketDetail; focus: string | null; onFocus: (stage: string | null) => void; refresh: () => Promise<void> }) {
  const click = (ev: MouseEvent) => {
    const station = (ev.target as Element).closest<SVGElement>("[data-stage]");
    if (!station) return;
    const stage = station.dataset.stage!;
    onFocus(stage === focus ? null : stage);
  };
  // The diagram is laid out for the panel's width, and again whenever it changes.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth) || null));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const panel = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [sending, setSending] = useState<Hovered | null>(null);
  const over = (ev: MouseEvent) => {
    if (!ticket.send) return;
    const station = (ev.target as Element).closest<SVGElement>("[data-stage]");
    if (!station || !panel.current) return;
    const at = station.getBoundingClientRect();
    const within = panel.current.getBoundingClientRect();
    setHovered({ stage: station.dataset.stage!, left: at.left - within.left + at.width / 2, top: at.bottom - within.top });
  };
  // Only a pointer that goes somewhere else on the page takes the offer away; one leaving the window leaves it be.
  const leave = (ev: MouseEvent) => {
    const to = ev.relatedTarget;
    if (to instanceof Node && !panel.current?.contains(to)) setHovered(null);
  };
  const unavailable = ticket.send?.unavailable ?? undefined;
  return (
    <div className="flow-wrap" ref={panel} onMouseLeave={leave}>
      <div className="flow" data-role="flow">
        <div ref={box} onClick={click} onMouseOver={over} dangerouslySetInnerHTML={{ __html: metroDiagram(ticket, focus, width) }} />
        <div className="legend">{LEGEND}</div>
      </div>
      {ticket.send && hovered && !sending && (
        <button
          type="button"
          className="sm send-here"
          data-role="send-here"
          data-stage={hovered.stage}
          style={{ left: hovered.left, top: hovered.top }}
          disabled={!!unavailable}
          title={unavailable ?? `Send ${ticket.label} to ${hovered.stage}`}
          onClick={() => setSending(hovered)}
        >
          Send here
        </button>
      )}
      {ticket.send && sending && (
        <div className="send-at" style={{ left: sending.left, top: sending.top }}>
          <SendPopover ticket={ticket} stage={sending.stage} within={panel} onSent={refresh} onClose={() => setSending(null)} />
        </div>
      )}
    </div>
  );
}

const OUTCOME_COLOUR: Record<string, string> = { succeeded: "var(--good)", failed: "var(--crit)", exhausted: "var(--crit)", interrupted: "var(--amber)" };

/**
 * The Sessions timeline, newest first, action Stages included, narrowed to the focused Stage when there is one. A row
 * click points the Session pane at that Session; the one it shows is marked.
 */
export function Timeline({ ticket: t, focus, onFocus, selected, onSelect }: { ticket: TicketDetail; focus: string | null; onFocus: (stage: string | null) => void; selected: string | null; onSelect: (session: string) => void }) {
  const sessions = sessionsForStage(t.sessions, focus);
  return (
    <div className="panel" data-role="timeline">
      <div className="head">
        <h3>{"Sessions" + (focus ? " · " + focus : "")}</h3>
        {focus && (
          <button type="button" className="sm" data-role="stage-filter" onClick={() => onFocus(null)}>
            All Stages
          </button>
        )}
      </div>
      {sessions.length ? (
        <ul className="timeline">
          {sessions.map((s) => (
            <li
              key={s.id}
              data-session={s.id}
              className={s.id === selected ? "sel" : undefined}
              aria-current={s.id === selected ? "true" : undefined}
              onClick={() => onSelect(s.id)}
              style={{ "--c": s.running ? "var(--run)" : (s.outcome && OUTCOME_COLOUR[s.outcome]) || "var(--muted)" } as CSSProperties}
            >
              <span className="when">{relative(s.startedAt)}</span>
              <span className={"pill " + (s.running ? "running" : s.outcome || "")}>{s.running ? "running" : s.outcome || "?"}</span>
              <span>{sessionLabel(s)}</span>
              <span className="muted">{s.mode + " · " + s.startedBy + (s.endedReason ? " · " + s.endedReason : "") + " · " + duration(s.durationMs) + (s.costUsd === null ? "" : " · $" + s.costUsd.toFixed(2))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">{focus ? "no Sessions of " + focus + " yet" : "no Sessions yet"}</span>
      )}
    </div>
  );
}
