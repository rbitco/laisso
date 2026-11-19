import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { PrView, TicketView } from "../../../api/views.ts";
import { ledgerStageText, metroTrack, quickAction, relative } from "../../metro.ts";
import { useClock } from "../clock.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { MiniRings } from "../ticket/Budget.tsx";
import { prStateWord, prTone } from "../ticket/PullRequests.tsx";
import { listTickets, message, pullTrigger } from "../ticket/ticket.ts";
import { ENDED, endedShown, shownTickets, type Hidden } from "./filter.ts";
import { SetupCard } from "./SetupCard.tsx";

export interface LedgerProps {
  /** The displayed states the filter leaves out (CONTEXT.md: Ledger). */
  hidden: Hidden;
  /** Bumped each time the Ledger is shown, so it reads the Tickets afresh. */
  visit: number;
  /** Told every Ticket each read brings, before the filter, so the app can count them. */
  onRead?: (tickets: TicketView[]) => void;
}

/** How long changes the server names are gathered before acting on them, so a burst re-reads once. */
const GATHER_MS = 100;

/**
 * The Ledger: one row per Ticket the filter lets through, in the order the API serves them: attention first, newest
 * activity within a group. Done and Abandoned are read only while the filter shows them, greyed (CONTEXT.md: Ledger).
 * A "ticket" event re-reads it; a read that a newer one has overtaken is dropped.
 */
export function Ledger({ hidden, visit, onRead }: LedgerProps) {
  const [tickets, setTickets] = useState<TicketView[] | null>(null);
  const ended = endedShown(hidden);
  const latest = useRef({ ended, onRead });
  latest.current = { ended, onRead };
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const list = await listTickets(latest.current.ended);
      if (mine !== reads.current) return;
      setTickets(list);
      latest.current.onRead?.(list);
    } catch (error) {
      showNotice(message(error));
    }
  }, []);
  // Showing or hiding an active state needs no read: every active Ticket is already here.
  useEffect(() => void read(), [read, visit, ended.join()]);

  const owed = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents(["ticket"], () => {
    owed.current ??= setTimeout(() => {
      owed.current = null;
      void read();
    }, GATHER_MS);
  });
  useEffect(() => () => clearTimeout(owed.current ?? undefined), []);

  if (!tickets) return null;
  if (!tickets.length) return <SetupCard empty={ended.length === ENDED.length ? "No Tickets yet. Paste a reference or a prompt above to start one." : "No active Tickets. Paste a reference or a prompt above to start one."} />;
  const shown = shownTickets(tickets, hidden);
  if (!shown.length) return <p className="empty" data-role="filtered-out">Every Ticket is hidden by the filter.</p>;
  return (
    <>
      {shown.map((t) => (
        <TicketRow key={t.id} ticket={t} onPulled={read} />
      ))}
    </>
  );
}

/**
 * A Ledger row: status pill, reference over repo, title over the why line (led by a chip per Owned PR), the mini Metro
 * track with the Stage name, four mini rings, last activity, and the one quick action (spec: Ledger). A click opens
 * the Ticket.
 */
function TicketRow({ ticket: t, onPulled }: { ticket: TicketView; onPulled: () => Promise<void> }) {
  return (
    <article className={"ticket" + (t.state === "active" ? "" : " ended")} data-id={t.id} onClick={() => (location.hash = t.id)}>
      <span className={"pill " + t.display.state} data-role="pill">
        {t.display.label || t.display.state}
      </span>
      <div className="id-cell">
        <div className="ref" data-role="ref" title={t.name ? `${t.name} (${t.reference || t.shortId})` : t.label}>
          {t.label}
        </div>
        <div className="repo" title={t.repo}>
          {t.repo}
        </div>
      </div>
      <div className="title-cell">
        <div className="title" title={t.title}>
          {t.title}
        </div>
        <div className="why" data-role="why" title={t.display.why}>
          {t.prs
            .filter((p) => p.role === "owned")
            .map((p) => (
              <PrChip key={p.url} pr={p} />
            ))}
          {t.display.why}
        </div>
      </div>
      <div className="track" data-role="track">
        <div dangerouslySetInnerHTML={{ __html: metroTrack(t) }} />
        <span className="stage" data-role="stage-text" title={ledgerStageText(t)}>
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

/** An Owned PR on the why line: a dot in the PR's tone and its number, linking to GitHub without opening the Ticket. */
function PrChip({ pr: p }: { pr: PrView }) {
  return (
    <a className="lpr" data-role="pr-chip" href={p.url} target="_blank" rel="noopener" title={[p.title, prStateWord(p)].filter(Boolean).join(" · ")} onClick={(ev) => ev.stopPropagation()}>
      <span className={"dot " + prTone(p)} />
      {"#" + p.number}
    </a>
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
