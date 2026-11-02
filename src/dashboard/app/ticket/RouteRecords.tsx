import type { EarlierRecordView, RouteRecordView, TicketDetail, UpgradeView } from "../../../api/views.ts";
import { relative } from "../../metro.ts";

/**
 * The records behind the arc clicked on the Stage track (LASSO-199), newest first, in the right-hand stack: who chose
 * each, when, what it added to the target's prompt, the note it carried, and the Route's count after it. A human's
 * send says it does not count; nothing here warns that a send would Flag, since a human's choice never does.
 */
export function RouteRecords({ ticket: t, arc: key, onClose }: { ticket: TicketDetail; arc: string; onClose: () => void }) {
  const label = (stage: string) => t.stages.find((s) => s.name === stage)?.label ?? stage;
  const upgrade = t.upgrades.find((u) => u.key === key);
  if (upgrade) return <UpgradeRecords upgrade={upgrade} label={label} onClose={onClose} />;
  const arc = t.arcs.find((a) => a.key === key);
  if (!arc) return null;
  const send = arc.kind === "send";
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
          <Record key={r.visit} from={arc.from} record={r} label={label} />
        ))}
      </ol>
    </div>
  );
}

const CHOOSER: Record<RouteRecordView["chosenBy"], string> = { agent: "agent", action: "Action", check: "check", human: "human" };

/**
 * A Version upgrade's marker, opened (LASSO-201): which Versions, whether the Visit continued or a new one landed, the
 * pick it dropped, and the Route and send records before it that touch a Stage the track no longer has, each marked
 * as from an earlier Version.
 */
function UpgradeRecords({ upgrade: u, label, onClose }: { upgrade: UpgradeView; label: (stage: string) => string; onClose: () => void }) {
  return (
    <div className="panel route-records" data-role="upgrade-records">
      <div className="head">
        <h3>{`Upgraded ${u.from === null ? "" : `v${u.from} → `}v${u.to}`}</h3>
        <button type="button" className="sm" onClick={onClose}>
          Close
        </button>
      </div>
      <span className="muted">
        {(u.landed ? `Landed on ${label(u.stage)}, on a new Visit` : `Continued on ${label(u.stage)}, the same Visit`) + " · "}
        <span title={new Date(u.at).toLocaleString()}>{relative(u.at)}</span>
      </span>
      {u.dropped && (
        <div className="dropped" data-role="upgrade-dropped">
          {`Dropped the ${u.dropped.by ? CHOOSER[u.dropped.by] + "'s " : ""}pick of Route ${u.dropped.route}` + (u.dropped.to ? ` to ${u.dropped.to}` : "") + "; the new Version has no such Route or target"}
          {u.dropped.note && <div>{"Note: " + u.dropped.note}</div>}
        </div>
      )}
      {u.earlier.length > 0 && (
        <ol className="records">
          {u.earlier.map((r) => (
            <Record key={r.visit} from={r.from} record={r} label={label} earlier={r} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Record({ from, record: r, label, earlier }: { from: string; record: RouteRecordView; label: (stage: string) => string; earlier?: EarlierRecordView }) {
  const human = r.chosenBy === "human";
  const who = human ? (r.route ? `sent by you, using Route ${r.route}` : "sent by you") : `chosen by ${label(from)}'s ${CHOOSER[r.chosenBy]}`;
  const budget = r.budget ? `${r.budget.used}/${r.budget.limit ?? "?"}` : "doesn't count";
  return (
    <li data-role="route-record" className={earlier ? "earlier" : undefined}>
      <div>
        <strong>{(earlier ? `${earlier.kind === "send" ? "Sent" : "Route " + r.route} · ${label(from)} → ` : "") + `${label(r.to)} · Visit ${r.number}`}</strong>
        {earlier && <span className="muted" data-role="earlier-version">{` · earlier Version${earlier.version === null ? "" : ` (v${earlier.version})`}`}</span>}
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
