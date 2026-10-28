import type { RouteArcView, RouteRecordView, TicketDetail } from "../../../api/views.ts";
import { relative } from "../../metro.ts";

/**
 * The records behind the arc clicked on the Stage track (LASSO-199), newest first, in the right-hand stack: who chose
 * each, when, what it added to the target's prompt, the note it carried, and the Route's count after it. A human's
 * send says it does not count; nothing here warns that a send would Flag, since a human's choice never does.
 */
export function RouteRecords({ ticket: t, arc: key, onClose }: { ticket: TicketDetail; arc: string; onClose: () => void }) {
  const arc = t.arcs.find((a) => a.key === key);
  if (!arc) return null;
  const send = arc.kind === "send";
  const label = (stage: string) => t.stages.find((s) => s.name === stage)?.label ?? stage;
  return (
    <div className="panel route-records" data-role="route-records">
      <div className="head">
        <h3>{`${send ? "Sent by you" : "Route " + arc.route} · ${label(arc.from)} → ${label(arc.to)}`}</h3>
        <button type="button" className="sm" onClick={onClose}>
          Close
        </button>
      </div>
      {arc.budget && (
        <span className={arc.spent ? "spent" : "muted"} data-role="route-budget">
          {`Taken ${arc.budget.used} of ${arc.budget.limit}` + (arc.spent ? "; spent, so another pick by an agent, Action or check Flags" : "")}
        </span>
      )}
      <ol className="records">
        {arc.records.map((r) => (
          <Record key={r.visit} arc={arc} record={r} label={label} />
        ))}
      </ol>
    </div>
  );
}

const CHOOSER: Record<RouteRecordView["chosenBy"], string> = { agent: "agent", action: "Action", check: "check", human: "human" };

function Record({ arc, record: r, label }: { arc: RouteArcView; record: RouteRecordView; label: (stage: string) => string }) {
  const human = r.chosenBy === "human";
  const who = human ? (r.route ? `sent by you, using Route ${r.route}` : "sent by you") : `chosen by ${label(arc.from)}'s ${CHOOSER[r.chosenBy]}`;
  const budget = r.budget ? `${r.budget.used}/${r.budget.limit ?? "?"}` : "doesn't count";
  return (
    <li data-role="route-record">
      <div>
        <strong>{`${label(r.to)} · Visit ${r.number}`}</strong>
        <span className="muted">
          {` · ${who} · `}
          <span title={new Date(r.at).toLocaleString()}>{relative(r.at)}</span>
          {` · ${budget}`}
        </span>
      </div>
      {r.text && <blockquote data-role="route-text">{(r.replaces ? "Replaced the prompt with: " : "Added to the prompt: ") + r.text}</blockquote>}
      {r.note && <div data-role="route-note">{(human ? "Instructions: " : "Note: ") + r.note}</div>}
    </li>
  );
}
