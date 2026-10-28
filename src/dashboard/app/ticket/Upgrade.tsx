import { useEffect, useRef, useState, type RefObject } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import type { UpgradePlan } from "../../../session/upgrade.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { message, pullTrigger, ticketRoute } from "./ticket.ts";

/**
 * Upgrade beside the Pipeline Version when the file has moved on (ADR 0009, LASSO-201): the lever, and the dialog it
 * opens. The dialog reads what the upgrade would do, offers the Stage to land on (the Ticket's own, its Visit
 * continuing, when the new Version keeps it), says where a pending or held Route pick now goes, and warns when the
 * pick will be dropped; confirming sends the landing, and drop: true when the warning was shown.
 */
export function UpgradeLever({ ticket: t, refresh }: { ticket: TicketDetail; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  return (
    <span className="upgrade-at" ref={box}>
      {" · "}
      <button type="button" className="rename" data-role="upgrade" onClick={() => setOpen((o) => !o)}>
        Upgrade
      </button>
      {open && <UpgradePopover ticket={t} within={box} onDone={refresh} onClose={() => setOpen(false)} />}
    </span>
  );
}

function UpgradePopover({ ticket: t, within, onDone, onClose }: { ticket: TicketDetail; within: RefObject<HTMLElement | null>; onDone: () => Promise<void>; onClose: () => void }) {
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [landing, setLanding] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    let live = true;
    api<UpgradePlan>(ticketRoute(t.id) + "/upgrade").then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setLanding(p.keeps ? p.stage : (p.stages[0] ?? ""));
      },
      (error) => {
        if (!live) return;
        showNotice(message(error));
        latestClose.current();
      },
    );
    return () => {
      live = false;
    };
  }, [t.id]);

  useEffect(() => {
    const away = (ev: PointerEvent) => {
      if (!within.current?.contains(ev.target as Node)) latestClose.current();
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") latestClose.current();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [within]);

  if (!plan) {
    return (
      <div className="upgrade-pop" role="dialog" aria-label="Upgrade" data-role="upgrade-pop">
        <span>Reading the Pipeline…</span>
      </div>
    );
  }
  const stays = landing === plan.stage;
  // The pick only matters when the Ticket stays on its Stage; a landing elsewhere starts a fresh Visit without it.
  const pick = stays ? plan.pick : null;
  const confirm = async () => {
    setBusy(true);
    try {
      await pullTrigger(t.id, "upgrade", { ...(stays ? {} : { stage: landing }), ...(pick?.dropped ? { drop: true } : {}) });
      onClose();
      await onDone();
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="upgrade-pop" role="dialog" aria-label={`Upgrade to v${plan.to}`} data-role="upgrade-pop">
      <strong>{`Upgrade ${t.pipeline} ${plan.from === null ? "" : `v${plan.from} `}to v${plan.to}?`}</strong>
      <span>{plan.keeps ? `${plan.stage} is still a Stage; staying, its Visit goes on with its attempts, Rounds and Route counts.` : `The new Version has no ${plan.stage}; pick the Stage the Ticket lands on.`}</span>
      <label>
        <span>Land on</span>
        <select aria-label="Land on" data-role="upgrade-landing" value={landing} onChange={(ev) => setLanding(ev.target.value)}>
          {plan.stages.map((s) => (
            <option key={s} value={s}>
              {s === plan.stage ? `${s} (stay)` : s}
            </option>
          ))}
        </select>
      </label>
      {pick && !pick.dropped && pick.to && (
        <span data-role="upgrade-pick">{`The ${pick.held ? "held " : ""}pick of Route ${pick.route} now goes to ${pick.to}` + (pick.from && pick.from !== pick.to ? ` (was ${pick.from})` : "") + "."}</span>
      )}
      {pick?.dropped && (
        <span className="warn" data-role="upgrade-warning">
          {`${pick.dropped}: upgrading drops the ${pick.held ? "held " : ""}pick of it` + (pick.note ? ` and its note "${pick.note}"` : "") + "."}
        </span>
      )}
      {plan.unavailable && <span className="warn">{plan.unavailable}</span>}
      <div className="upgrade-actions">
        <button type="button" className="sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sm primary" data-role="upgrade-confirm" disabled={busy || !!plan.unavailable} onClick={() => void confirm()}>
          {pick?.dropped ? "Upgrade and drop the pick" : "Upgrade"}
        </button>
      </div>
    </div>
  );
}
