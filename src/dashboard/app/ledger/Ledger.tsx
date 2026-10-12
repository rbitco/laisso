import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { TicketView } from "../../../api/views.ts";
import { ledgerStageText, metroTrack, quickAction, relative } from "../../metro.ts";
import { useClock } from "../clock.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { MiniRings } from "../ticket/Budget.tsx";
import { listTickets, message, pullTrigger } from "../ticket/ticket.ts";

export interface LedgerProps {
  /** Whether done and Abandoned Tickets are listed too, greyed. */
  all: boolean;
  /** Bumped each time the Ledger is shown, so it reads the Tickets afresh. */
  visit: number;
}

/** How long changes the server names are gathered before acting on them, so a burst re-reads once. */
const GATHER_MS = 100;

/**
 * The Ledger: one row per Ticket, in the order the API serves them: attention first, newest activity within a group.
 * Done and Abandoned sit behind the toggle, greyed (CONTEXT.md: Ledger). A "ticket" event re-reads it; a read that a
 * newer one has overtaken is dropped.
 */
export function Ledger({ all, visit }: LedgerProps) {
  const [tickets, setTickets] = useState<TicketView[] | null>(null);
  const latestAll = useRef(all);
  latestAll.current = all;
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const list = await listTickets(latestAll.current);
      if (mine === reads.current) setTickets(list);
    } catch (error) {
      showNotice(message(error));
    }
  }, []);
  useEffect(() => void read(), [read, visit, all]);

  const owed = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents(["ticket"], () => {
    owed.current ??= setTimeout(() => {
      owed.current = null;
      void read();
    }, GATHER_MS);
  });
  useEffect(() => () => clearTimeout(owed.current ?? undefined), []);

  if (!tickets) return null;
  if (!tickets.length) return <p className="empty">{all ? "No Tickets yet. Paste a reference or a prompt above to start one." : "No active Tickets. Paste a reference or a prompt above to start one."}</p>;
  return (
    <>
      {tickets.map((t) => (
        <TicketRow key={t.id} ticket={t} onPulled={read} />
      ))}
    </>
  );
}

/**
 * A Ledger row: status pill, reference over repo, title over the why line, the mini Metro track with the Stage name,
 * four mini rings, last activity, and the one quick action (spec: Ledger). A click opens the Ticket.
 */
function TicketRow({ ticket: t, onPulled }: { ticket: TicketView; onPulled: () => Promise<void> }) {
  return (
    <article className={"ticket" + (t.state === "active" ? "" : " ended")} data-id={t.id} onClick={() => (location.hash = t.id)}>
      <span className={"pill " + t.display.state} data-role="pill">
        {t.display.label || t.display.state}
      </span>
      <div>
        <div className="ref" data-role="ref">
          {t.reference || t.shortId}
        </div>
        <div className="repo">{t.repo}</div>
      </div>
      <div className="title-cell">
        <div className="title">{t.title}</div>
        <div className="why" data-role="why">
          {t.display.why}
        </div>
      </div>
      <div className="track" data-role="track">
        <div dangerouslySetInnerHTML={{ __html: metroTrack(t) }} />
        <span className="stage" data-role="stage-text">
          {ledgerStageText(t)}
        </span>
      </div>
      <MiniRings budget={t.budget} />
      <LastActivity at={t.updatedAt} />
      <div className="quick" data-role="quick">
        <QuickAction ticket={t} onPulled={onPulled} />
      </div>
    </article>
  );
}

/** How long ago the Ticket last moved, kept current each second; the exact time on hover. */
function LastActivity({ at }: { at: string }) {
  useClock();
  return (
    <div className="last" data-role="last" title={at}>
      {relative(at)}
    </div>
  );
}

/** The row's one quick action, if it has one; busy until it went through and the Ledger was read again. */
function QuickAction({ ticket: t, onPulled }: { ticket: TicketView; onPulled: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const action = quickAction(t);
  if (!action) return null;
  const pull = async (ev: MouseEvent) => {
    ev.stopPropagation();
    setBusy(true);
    try {
      await pullTrigger(t.id, action.action);
      await onPulled();
    } catch (error) {
      showNotice(message(error));
    }
    setBusy(false);
  };
  return (
    <button type="button" className={"sm" + (action.action === "check" ? "" : " primary") + (busy ? " busy" : "")} data-action={action.action} disabled={busy} onClick={pull}>
      {action.label}
    </button>
  );
}
