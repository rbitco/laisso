import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TicketDetail, TicketView } from "../../../api/views.ts";
import type { Drift } from "../../../store/versions.ts";
import type { ArtifactCheck } from "../../../store/visits.ts";
import { relative } from "../../metro.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { pipelineHref } from "../pipelines/href.ts";
import { ticketHref, type Selection } from "../route.ts";
import { BudgetEditor, Gauges } from "./Budget.tsx";
import { PrCount, PrPanel } from "./PullRequests.tsx";
import { RouteRecords } from "./RouteRecords.tsx";
import { Flow, Timeline } from "./Flow.tsx";
import { SessionPane, sessionLabel, worktreeGone } from "./SessionPane.tsx";
import { shownSession, type Shown } from "./selection.ts";
import { StageProfiles } from "./StageProfiles.tsx";
import { listTickets, message, readTicket } from "./ticket.ts";
import { Triggers } from "./Triggers.tsx";

export interface TicketPageProps {
  /** The Ticket asked for: its id, or any key the API finds it by. */
  id: string;
  /** The Session or Stage the Session pane is pointed at, from the hash; null for the live Session. */
  select: Selection;
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

/**
 * A Ticket's page, with the Ledger collapsed to a sidebar beside it. The Ticket and the sidebar arrive together, so
 * the page changes once; until the asked-for Ticket arrives the page keeps what it showed. A read that a newer one
 * has overtaken is dropped, so a slow answer for an earlier Ticket never draws over a later one. A "ticket" event
 * for the Ticket shown re-reads both; for any other, the sidebar alone.
 */
export function TicketPage({ id, select, visit, all, side, onShown }: TicketPageProps) {
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
      <TicketBody key={shown.detail.id} ticket={shown.detail} select={select} refresh={read} />
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
            <div className="ref">{t.label + " · " + t.repo + " · " + t.stage.label}</div>
            <div className="title">{t.title}</div>
          </div>
        </div>
      ))}
    </>
  );
}

/** The name, edited in place: Enter or Save keeps it, Escape or Cancel leaves it, and an empty name clears it. */
function NameEditor({ ticket: t, done, refresh }: { ticket: TicketDetail; done: () => void; refresh: () => Promise<void> }) {
  const [value, setValue] = useState(t.name ?? "");
  const [saving, setSaving] = useState(false);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaving(true);
    try {
      await api(`/api/tickets/${t.id}/name`, { method: "PUT", body: JSON.stringify({ name: value.trim() || null }) });
      await refresh();
      done();
    } catch (error) {
      showNotice(message(error));
      setSaving(false);
    }
  };
  return (
    <form className="name-editor" data-role="name-editor" onSubmit={save} onKeyDown={(ev) => ev.key === "Escape" && done()}>
      <input aria-label="Ticket name" autoFocus value={value} maxLength={80} disabled={saving} placeholder={`shown in place of ${t.reference || t.shortId}`} onChange={(ev) => setValue(ev.target.value)} />
      <button type="submit" className={"sm primary" + (saving ? " busy" : "")} disabled={saving}>
        Save
      </button>
      <button type="button" className="sm" disabled={saving} onClick={done}>
        Cancel
      </button>
    </form>
  );
}

/**
 * One Ticket's page; it is drawn afresh for each Ticket, so nothing typed or armed on one carries to another. The
 * selection lives in the hash, so a reload keeps it and a Session can be linked; choosing a Stage or a Session moves it.
 */
function TicketBody({ ticket: t, select, refresh }: { ticket: TicketDetail; select: Selection; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  // The Route arc whose records show in the right-hand stack (LASSO-199).
  const [arc, setArc] = useState<string | null>(null);
  // The live Session when this selection was made, so one starting later is noticed rather than jumped to.
  const key = ticketHref(t.id, select);
  const [baseline, setBaseline] = useState({ key, live: t.session?.id ?? null });
  if (baseline.key !== key) setBaseline({ key, live: t.session?.id ?? null });
  const shown = shownSession(t, select, baseline.key === key ? baseline.live : (t.session?.id ?? null));
  const narrowed = shown.stage;
  const go = (to: Selection) => void (location.hash = ticketHref(t.id, to));
  const setFocus = (stage: string | null) => go(stage ? { stage } : null);
  const triggers = <Triggers ticket={t} onExtend={() => setEditing(true)} refresh={refresh} />;
  return (
    <>
      <TitleBar ticket={t} refresh={refresh}>
        {!t.flag && triggers}
      </TitleBar>
      <Flow ticket={t} focus={narrowed} onFocus={setFocus} arc={arc} onArc={setArc} refresh={refresh} />
      {t.flag && <FlagBox ticket={t}>{triggers}</FlagBox>}
      <div className="dgrid">
        <div className="stack">
          {(shown.past || shown.empty) && <Viewing ticket={t} shown={shown} back={() => go(null)} />}
          {shown.empty ? null : shown.session ? <SessionPane key={shown.session.id} ticket={t} session={shown.session} past={shown.past} refresh={refresh} /> : <div className="panel muted">No Session yet.</div>}
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
          {arc && <RouteRecords ticket={t} arc={arc} onClose={() => setArc(null)} />}
          <PrPanel ticket={t} />
          <div className="panel">
            <h3>Budget</h3>
            <Gauges budget={t.budget} onOpen={() => setEditing(true)} />
            {editing && <BudgetEditor ticket={t} onClose={() => setEditing(false)} onSaved={refresh} />}
          </div>
          <Timeline ticket={t} focus={narrowed} onFocus={setFocus} selected={shown.session?.id ?? null} onSelect={(session) => go({ session })} />
          <StageProfiles ticket={t} refresh={refresh} />
        </div>
      </div>
    </>
  );
}

/**
 * Over a past Session's pane, or in place of the pane for a Stage with no Sessions: what is shown, and the way back to
 * the live Session. It turns blue and names a Session that started since, without moving the pane; otherwise it says
 * when the live Session is running.
 */
function Viewing({ ticket: t, shown, back }: { ticket: TicketDetail; shown: Shown; back: () => void }) {
  // A Stage a human skipped (LASSO-159) says so, and when: in place of "No Sessions", or after the Session viewed.
  const skippedAt = t.stages.find((s) => s.name === shown.stage)?.skippedAt ?? null;
  const what = shown.empty ? (skippedAt ? `Skipped ${shown.stage}` : `No Sessions for ${shown.stage} yet`) : "Viewing " + sessionLabel(shown.session!);
  const live = t.session;
  return (
    <div className={"viewing" + (shown.empty ? " empty" : "") + (shown.newer ? " newer" : "")} data-role={shown.empty ? "empty-stage" : "viewing"}>
      <span>
        {what}
        {skippedAt && (
          <span className="muted" data-role="skipped" title={new Date(skippedAt).toLocaleString()}>
            {(shown.empty ? " " : " · skipped ") + relative(skippedAt)}
          </span>
        )}
        {shown.newer ? (
          <span data-role="newer">{" · " + sessionLabel(shown.newer) + " has started"}</span>
        ) : (
          live?.running && <span className="muted">{" · the current Session, " + sessionLabel(live) + ", is running"}</span>
        )}
      </span>
      <button type="button" className="sm" onClick={back}>
        Back to current
      </button>
    </div>
  );
}

/**
 * The name and reference, repo, branch and PR count over the title and why; the pill, then the levers unless the Flag
 * box has them. Rename edits the name in place.
 */
function TitleBar({ ticket: t, refresh, children }: { ticket: TicketDetail; refresh: () => Promise<void>; children: ReactNode }) {
  const [naming, setNaming] = useState(false);
  const id = t.reference || t.shortId;
  return (
    <div className="titlebar" data-role="titlebar">
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">
          {naming ? (
            <NameEditor ticket={t} done={() => setNaming(false)} refresh={refresh} />
          ) : (
            t.name && (
              <span className="tname" data-role="name">
                {t.name}
              </span>
            )
          )}
          {t.name && !naming && " · "}
          <span>{id + " · " + t.repo + " · " + t.branch}</span>
          <PrCount ticket={t} />
          {!naming && (
            <>
              {" · "}
              <button type="button" className="rename" data-role="rename" onClick={() => setNaming(true)}>
                {t.name ? "Rename" : "Name"}
              </button>
            </>
          )}
        </div>
        <h2>{t.title}</h2>
        <div className="why">{t.display.why + (t.mirrorPending ? " · tracker labels not written yet" : "")}</div>
        {t.check && <CheckLine check={t.check} />}
      </div>
      <div className="right">
        <span className={"pill " + t.display.state}>{t.display.label}</span>
        {children}
      </div>
    </div>
  );
}

const CHECK_WORDS: Record<ArtifactCheck["result"], string> = { met: "met", not_met: "not met", error: "broken" };

/** How the Stage's check Action last came out (ADR 0014): the Action, met or not, when, and its last line. */
function CheckLine({ check }: { check: ArtifactCheck }) {
  return (
    <div className={"check " + check.result} data-role="check">
      <span className="what">{check.action + ": " + CHECK_WORDS[check.result]}</span>
      <span className="muted">{" · " + relative(check.at)}</span>
      {check.line && <span className="line">{check.line}</span>}
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
