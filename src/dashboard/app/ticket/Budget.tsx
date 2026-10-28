import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import type { BudgetView, GaugeView, TicketBudget } from "../../../budget/budget.ts";
import { duration } from "../../metro.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { message, ticketRoute } from "./ticket.ts";

type GaugeKey = Exclude<keyof TicketBudget, "routes">;

/**
 * The four gauges in the order shown: key, name, and the used/limit text. On a human Stage wall time and spend are
 * not tracked; spend still says what earlier Sessions spent, as that counts against the Ticket.
 */
export const GAUGES: Array<[GaugeKey, string, (g: BudgetView[GaugeKey]) => string]> = [
  ["rounds", "Rounds", (g) => g.used + "/" + g.limit],
  ["attempts", "attempts", (g) => g.used + "/" + g.limit],
  ["wallTime", "wall time", (g) => (g.untracked ? "not tracked" : duration(g.used) + "/" + ("limitText" in g ? g.limitText : ""))],
  ["spend", "spend", (g) => (g.untracked ? (g.used > 0 ? "$" + g.used.toFixed(2) + " so far" : "not tracked") : "$" + g.used.toFixed(2) + "/$" + g.limit)],
];

const UNTRACKED = "not tracked in a terminal Session: Lasso reads none of its output";

/** The share of a gauge used, 1 when it has no limit. */
const shareOf = (g: GaugeView) => (g.limit > 0 ? g.used / g.limit : 1);
const level = (share: number) => (share >= 1 ? "over" : share >= 0.7 ? "warn" : "");
/** A gauge's colour class: greyed when untracked, else by the share used. */
const classOf = (g: GaugeView) => (g.untracked ? "untracked" : level(shareOf(g)));

/** One ring: the arc is the share used, amber from 70 %, red at the limit. */
function Ring({ gauge, size }: { gauge: GaugeView; size: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const share = Math.min(1, shareOf(gauge));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={classOf(gauge)}>
      <circle className="track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="arc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
    </svg>
  );
}

/** The Ledger's four mini rings, no words; the hover names each. */
export function MiniRings({ budget }: { budget: BudgetView }) {
  return (
    <span className="rings" data-role="rings" title={GAUGES.map(([k, name, text]) => name + " " + text(budget[k])).join(" · ")}>
      {GAUGES.map(([k]) => (
        <Ring key={k} gauge={budget[k]} size={18} />
      ))}
    </span>
  );
}

const SOURCE = { ticket: "on this Ticket", pipeline: "by the Pipeline", global: "globally" };

/** "1m30s/30m" as the used part, set large, and the "/30m" after it, set small. */
const splitValue = (value: string): [string, string] => {
  const at = value.indexOf("/");
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at)];
};

/** The four gauges, a number over a bar each; any of them opens the Ticket-layer editor (Extend). A starred value is set on the Ticket. */
export function Gauges({ budget, onOpen }: { budget: BudgetView; onOpen: () => void }) {
  return (
    <div className="gauges" data-role="gauges">
      {GAUGES.map(([k, name, text]) => {
        const g = budget[k];
        const cls = classOf(g);
        const [used, limit] = splitValue(text(g) + (g.source === "ticket" ? "*" : ""));
        return (
          <div key={k} className={"gauge" + (cls ? " " + cls : "")} data-gauge={k} title={(g.untracked ? UNTRACKED + "; " : "") + `set ${SOURCE[g.source]}; click to extend`} onClick={onOpen}>
            <span className="value">
              {used}
              {limit && <small>{limit}</small>}
            </span>
            <span className="meter" aria-hidden="true">
              <i style={{ width: `${Math.min(1, shareOf(g)) * 100}%` }} />
            </span>
            <span>{name}</span>
          </div>
        );
      })}
    </div>
  );
}

const SUFFIX: Partial<Record<keyof TicketBudget, string>> = { spend: " (USD)", wallTime: " (30m, 1h)" };

type Field = keyof TicketBudget;
type Draft = Record<Field, string>;
const draftOf = (t: TicketDetail): Draft => {
  const v = (k: Field) => (t.budget.ticket[k] === null ? "" : String(t.budget.ticket[k]));
  return { rounds: v("rounds"), attempts: v("attempts"), wallTime: v("wallTime"), spend: v("spend"), routes: v("routes") };
};

/** The editor's fields: the four gauges, then the one limit for each of the Ticket's Routes (it has no gauge). */
const FIELDS: Array<[Field, string]> = [...GAUGES.map(([k, name]): [Field, string] => [k, name]), ["routes", "times each Route"]];

/**
 * The Ticket layer of the Budget, edited inline: a blank falls back to the Pipeline or global value. Save sends Extend
 * with every field; `onSaved` follows once it went through.
 */
export function BudgetEditor({ ticket, onClose, onSaved }: { ticket: TicketDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => draftOf(ticket));
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.querySelector("input")?.focus(), []);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const body: Record<string, string | number | null> = {};
    for (const [k] of FIELDS) {
      const raw = draft[k].trim();
      if (raw !== "" && k !== "wallTime" && !/^\d+(\.\d+)?$/.test(raw)) {
        showNotice(k + " must be a number");
        form.current?.querySelector<HTMLInputElement>(`[name="${k}"]`)?.focus();
        return;
      }
      body[k] = raw === "" ? null : k === "wallTime" ? raw : Number(raw);
    }
    setBusy(true);
    try {
      await api(ticketRoute(ticket.id) + "/extend", { method: "POST", body: JSON.stringify(body) });
      onClose();
      await onSaved();
    } catch (error) {
      showNotice(message(error));
      setBusy(false);
    }
  };

  return (
    <form ref={form} className="editor" data-role="budget-editor" onSubmit={submit}>
      {FIELDS.map(([k, name]) => {
        const placeholder = k === "wallTime" ? ticket.budget.wallTime.limitText : k === "routes" ? String(ticket.budget.routes.value) : String(ticket.budget[k].limit);
        return (
          <label key={k}>
            {name + (SUFFIX[k] ?? "")}
            <input name={k} placeholder={placeholder} value={draft[k]} onChange={(ev) => setDraft((d) => ({ ...d, [k]: ev.target.value }))} />
          </label>
        );
      })}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <span className="why">blank falls back to the Pipeline or global value; a running Session keeps the wall time it started with</span>
      </div>
    </form>
  );
}
