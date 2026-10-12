import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import type { BudgetView, GaugeView, TicketBudget } from "../../../budget/budget.ts";
import { duration } from "../../metro.js";
import { api } from "../api.ts";
import { showNotice } from "../notice.ts";
import { message, ticketRoute } from "./ticket.ts";

type GaugeKey = keyof TicketBudget;

const GAUGES: Array<[GaugeKey, string, (g: BudgetView[GaugeKey]) => string]> = [
  ["rounds", "Rounds", (g) => g.used + "/" + g.limit],
  ["attempts", "attempts", (g) => g.used + "/" + g.limit],
  ["wallTime", "wall time", (g) => duration(g.used) + "/" + ("limitText" in g ? g.limitText : "")],
  ["spend", "spend", (g) => "$" + g.used.toFixed(2) + "/$" + g.limit],
];

/** The share of a gauge used, 1 when it has no limit. */
const shareOf = (g: GaugeView) => (g.limit > 0 ? g.used / g.limit : 1);
const level = (share: number) => (share >= 1 ? "over" : share >= 0.7 ? "warn" : "");

/** One ring: the arc is the share used, amber from 70 %, red at the limit. */
function Ring({ gauge, size }: { gauge: GaugeView; size: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const share = Math.min(1, shareOf(gauge));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={level(share)}>
      <circle className="track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="arc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
    </svg>
  );
}

const SOURCE = { ticket: "on this Ticket", pipeline: "by the Pipeline", global: "globally" };

/** The four ring gauges; any of them opens the Ticket-layer editor (Extend). A starred value is set on the Ticket. */
export function Gauges({ budget, onOpen }: { budget: BudgetView; onOpen: () => void }) {
  return (
    <div className="gauges" data-role="gauges">
      {GAUGES.map(([k, name, text]) => {
        const g = budget[k];
        const cls = level(shareOf(g));
        return (
          <div key={k} className={"gauge" + (cls ? " " + cls : "")} data-gauge={k} title={`set ${SOURCE[g.source]}; click to extend`} onClick={onOpen}>
            <Ring gauge={g} size={56} />
            <span className="value">{text(g) + (g.source === "ticket" ? "*" : "")}</span>
            <span>{name}</span>
          </div>
        );
      })}
    </div>
  );
}

const SUFFIX: Partial<Record<GaugeKey, string>> = { spend: " (USD)", wallTime: " (30m, 1h)" };

type Draft = Record<GaugeKey, string>;
const draftOf = (t: TicketDetail): Draft => {
  const v = (k: GaugeKey) => (t.budget.ticket[k] === null ? "" : String(t.budget.ticket[k]));
  return { rounds: v("rounds"), attempts: v("attempts"), wallTime: v("wallTime"), spend: v("spend") };
};

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
    for (const [k] of GAUGES) {
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
      {GAUGES.map(([k, name]) => {
        const g = ticket.budget[k];
        return (
          <label key={k}>
            {name + (SUFFIX[k] ?? "")}
            <input name={k} placeholder={k === "wallTime" ? ticket.budget.wallTime.limitText : String(g.limit)} value={draft[k]} onChange={(ev) => setDraft((d) => ({ ...d, [k]: ev.target.value }))} />
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
