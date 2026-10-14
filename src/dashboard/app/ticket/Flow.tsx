import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import { duration, metroDiagram, relative, sessionsForStage } from "../../metro.ts";
import { sessionLabel } from "./SessionPane.tsx";

const LEGEND =
  "Filled stations are done, the ringed station is current, a stop sign is Flagged, ticks are action Stages. The orbit above a repeating Stage is PR feedback with Rounds used of Budget on its badge; a small orbit counts attempts. Click a station to filter Sessions.";

/** The Metro flow diagram in its panel; a station click narrows the timeline to it, and a second click widens it again. */
export function Flow({ ticket, focus, onFocus }: { ticket: TicketDetail; focus: string | null; onFocus: (stage: string | null) => void }) {
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
  return (
    <div className="flow" data-role="flow">
      <div ref={box} onClick={click} dangerouslySetInnerHTML={{ __html: metroDiagram(ticket, focus, width) }} />
      <div className="legend">{LEGEND}</div>
    </div>
  );
}

const OUTCOME_COLOUR: Record<string, string> = { succeeded: "var(--good)", failed: "var(--crit)", exhausted: "var(--crit)", interrupted: "var(--amber)" };

/** The Sessions timeline, newest first, action Stages included, narrowed to the focused Stage when there is one. */
export function Timeline({ ticket: t, focus, onFocus }: { ticket: TicketDetail; focus: string | null; onFocus: (stage: string | null) => void }) {
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
            <li key={s.id} style={{ "--c": s.running ? "var(--run)" : (s.outcome && OUTCOME_COLOUR[s.outcome]) || "var(--muted)" } as CSSProperties}>
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
