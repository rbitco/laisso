import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TicketDetail, TicketView } from "../../../api/views.ts";
import type { Drift } from "../../../store/versions.ts";
import { relative } from "../../metro.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { pipelineHref } from "../pipelines/href.ts";
import { BudgetEditor, Gauges } from "./Budget.tsx";
import { Flow, Timeline } from "./Flow.tsx";
import { SessionPane, worktreeGone } from "./SessionPane.tsx";
import { StageProfiles } from "./StageProfiles.tsx";
import { listTickets, message, readTicket } from "./ticket.ts";
import { Triggers } from "./Triggers.tsx";

export interface TicketPageProps {
  /** The Ticket asked for: its id, or any key the API finds it by. */
  id: string;
  /** Bumped each time the page is shown, so it reads everything afresh. */
  visit: number;
  /** Whether the sidebar lists done and Abandoned Tickets too. */
  all: boolean;
  /** Where the sidebar of Tickets goes, beside the page. */
  side: HTMLElement | null;
  /** Called once each visit's Ticket is first drawn, so the app can swap the page in. */
  onShown: () => void;
}

/** How long changes the server names are gathered before acting on them, so a burst re-reads once. */
const GATHER_MS = 100;

// Which Stage the timeline is narrowed to, per Ticket, so it stays narrowed when the page is shown again.
const focusByTicket = new Map<string, string | null>();

/**
 * A Ticket's page, with the Ledger collapsed to a sidebar beside it. The Ticket and the sidebar arrive together, so
 * the page changes once; until the asked-for Ticket arrives the page keeps what it showed. A read that a newer one
 * has overtaken is dropped, so a slow answer for an earlier Ticket never draws over a later one. A "ticket" event
 * for the Ticket shown re-reads both; for any other, the sidebar alone.
 */
export function TicketPage({ id, visit, all, side, onShown }: TicketPageProps) {
  const [shown, setShown] = useState<{ detail: TicketDetail; list: TicketView[]; visit: number } | null>(null);
  // Every read asks for the latest Ticket, so a refresh from a page being left reads the one replacing it.
  const latest = useRef({ id, visit, all, onShown });
  latest.current = { id, visit, all, onShown };
  const detailReads = useRef(0);
  const listReads = useRef(0);

  const read = useCallback(async () => {
    const mine = ++detailReads.current;
    const mineList = ++listReads.current;
    const { id, visit, all } = latest.current;
    let detail: TicketDetail, list: TicketView[];
    try {
      [detail, list] = await Promise.all([readTicket(id), listTickets(all)]);
    } catch (error) {
      if (mine !== detailReads.current) return;
      showNotice(message(error));
      location.hash = "";
      return;
    }
    if (mine !== detailReads.current) return;
    setShown((was) => ({ detail, list: mineList === listReads.current || !was ? list : was.list, visit }));
  }, []);
  const readList = useCallback(async () => {
    const mine = ++listReads.current;
    try {
      const list = await listTickets(latest.current.all);
      if (mine === listReads.current) setShown((was) => was && { ...was, list });
    } catch (error) {
      showNotice(message(error));
    }
  }, []);

  useEffect(() => void read(), [read, id, visit]);
  useEffect(() => {
    if (shown) latest.current.onShown();
  }, [shown?.visit]);

  // Changes are gathered briefly and acted on together.
  const owed = useRef<{ list: boolean; tickets: Set<string>; timer: ReturnType<typeof setTimeout> | null }>({ list: false, tickets: new Set(), timer: null });
  const shownId = shown?.detail.id ?? null;
  const settle = () => {
    const { list, tickets } = owed.current;
    owed.current = { list: false, tickets: new Set(), timer: null };
    if (shownId && tickets.has(shownId)) void read();
    else if (list) void readList();
  };
  const settleLatest = useRef(settle);
  settleLatest.current = settle;
  useEvents(["ticket"], (event) => {
    const o = owed.current;
    o.list = true;
    try {
      o.tickets.add(JSON.parse(event.data).ticket);
    } catch {
      // An event without a Ticket still owes the sidebar a read.
    }
    o.timer ??= setTimeout(() => settleLatest.current(), GATHER_MS);
  });
  useEffect(() => () => clearTimeout(owed.current.timer ?? undefined), []);

  if (!shown) return null;
  return (
    <>
      <TicketBody key={shown.detail.id} ticket={shown.detail} refresh={read} />
      {side && createPortal(<Sidebar list={shown.list} current={shown.detail.id} />, side)}
    </>
  );
}

/** With a Ticket open the Ledger collapses to this sidebar: one compact line per Ticket, the open one marked. */
function Sidebar({ list, current }: { list: TicketView[]; current: string }) {
  return (
    <>
      <div className="back">
        <a className="back-link" href="#">
          ← all Tickets
        </a>
        <span className="muted">{list.length + " shown"}</span>
      </div>
      {list.map((t) => (
        <div key={t.id} className={"qitem" + (t.id === current ? " sel" : "") + (t.state === "active" ? "" : " ended")} data-id={t.id} onClick={() => (location.hash = t.id)}>
          <span className={"dot " + t.display.state} />
          <div style={{ minWidth: 0 }}>
            <div className="ref">{(t.reference || t.shortId) + " · " + t.repo + " · " + t.stage.label}</div>
            <div className="title">{t.title}</div>
          </div>
        </div>
      ))}
    </>
  );
}

/** One Ticket's page; it is drawn afresh for each Ticket, so nothing typed or armed on one carries to another. */
function TicketBody({ ticket: t, refresh }: { ticket: TicketDetail; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [focus, setFocusState] = useState(() => focusByTicket.get(t.id) ?? null);
  const setFocus = (stage: string | null) => {
    focusByTicket.set(t.id, stage);
    setFocusState(stage);
  };
  // A Stage the Pipeline no longer has narrows nothing.
  const narrowed = focus && t.stages.some((s) => s.name === focus) ? focus : null;
  const triggers = <Triggers ticket={t} onExtend={() => setEditing(true)} refresh={refresh} />;
  return (
    <>
      <TitleBar ticket={t}>{!t.flag && triggers}</TitleBar>
      <Flow ticket={t} focus={narrowed} onFocus={setFocus} />
      {t.flag && <FlagBox ticket={t}>{triggers}</FlagBox>}
      <div className="dgrid">
        <div className="stack">
          {t.session ? <SessionPane key={t.session.id} ticket={t} session={t.session} refresh={refresh} /> : <div className="panel muted">No Session yet.</div>}
          <dl>
            <dt>worktree</dt>
            <dd>{worktreeGone(t) ? t.worktree + " (removed)" : t.worktree}</dd>
            <dt>pipeline</dt>
            <PipelineCell ticket={t} />
            <dt>id</dt>
            <dd>{t.id}</dd>
          </dl>
        </div>
        <div className="stack">
          <div className="panel">
            <h3>Budget</h3>
            <Gauges budget={t.budget} onOpen={() => setEditing(true)} />
            {editing && <BudgetEditor ticket={t} onClose={() => setEditing(false)} onSaved={refresh} />}
          </div>
          <Timeline ticket={t} focus={narrowed} onFocus={setFocus} />
          <StageProfiles ticket={t} refresh={refresh} />
        </div>
      </div>
    </>
  );
}

/** The reference, repo, branch and PR link over the title and why; the pill, then the levers unless the Flag box has them. */
function TitleBar({ ticket: t, children }: { ticket: TicketDetail; children: ReactNode }) {
  return (
    <div className="titlebar" data-role="titlebar">
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">
          <span>{(t.reference || t.shortId) + " · " + t.repo + " · " + t.branch}</span>
          {t.pr && (
            <>
              {" · "}
              <a href={t.pr} target="_blank" rel="noopener" data-role="pr-link">
                PR
              </a>
            </>
          )}
        </div>
        <h2>{t.title}</h2>
        <div className="why">{t.display.why + (t.mirrorPending ? " · tracker labels not written yet" : "")}</div>
      </div>
      <div className="right">
        <span className={"pill " + t.display.state}>{t.display.label}</span>
        {children}
      </div>
    </div>
  );
}

/** The Flag box: why, when, the last word from the Runner, and the exits below it. */
function FlagBox({ ticket: t, children }: { ticket: TicketDetail; children: ReactNode }) {
  const flag = t.flag!;
  const last = t.session?.finalMessage;
  return (
    <div className="flagbox" data-role="flagbox">
      <div>
        <span className="reason">{flag.reason}</span> <span className="meta muted">{"Flagged " + relative(flag.at)}</span>
      </div>
      <div>{flag.detail || ""}</div>
      {last ? <div className="last">{last}</div> : <span />}
      {children}
    </div>
  );
}

// The Pipeline a Ticket runs: its Version, linked read-only, and a note when the file has moved on (ADR 0009).
const DRIFT_NOTE: Partial<Record<Drift, string>> = { changed: "Pipeline has changed", deleted: "Pipeline deleted", broken: "Pipeline file does not load" };

function PipelineCell({ ticket: t }: { ticket: TicketDetail }) {
  if (t.pipelineVersion === null) return <dd>{t.pipeline}</dd>;
  const note = t.pipelineDrift && DRIFT_NOTE[t.pipelineDrift];
  return (
    <dd data-role="pipeline-version">
      <a href={pipelineHref(t.pipeline, t.pipelineVersion)}>{t.pipeline + " v" + t.pipelineVersion}</a>
      {note && <span className="drift">{" · " + note}</span>}
    </dd>
  );
}
