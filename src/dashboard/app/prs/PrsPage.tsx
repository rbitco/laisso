import { useCallback, useEffect, useRef, useState } from "react";
import type { PrListsView, PrListView, PrRow } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useClock } from "../clock.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";

/** How long ago, in the largest whole unit up to days. */
export function age(iso: string, now: number = Date.now()): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The Pull Requests page: each PR List from config.yaml, stacked in config order. Read on each visit and again when
 * config changes, so an edit to pr_lists shows without a restart.
 */
export function PrsPage({ visit }: { visit: number }) {
  const [view, setView] = useState<PrListsView | null>(null);
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const lists = await api<PrListsView>("/api/pr-lists");
      // A slower, older read must not replace a newer one.
      if (mine === reads.current) setView(lists);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => void read(), [read, visit]);
  useEvents(["config"], () => void read());

  return (
    <div className="prs">
      <div className="ed-head">
        <h2>Pull Requests</h2>
      </div>
      {!view ? (
        <p className="note">Reading PR Lists from GitHub…</p>
      ) : view.lists.length ? (
        view.lists.map((list) => <PrListBlock key={list.name} list={list} />)
      ) : (
        <p className="note">No PR Lists. Add some under pr_lists: in config.yaml, or on the Config page.</p>
      )}
    </div>
  );
}

function PrListBlock({ list }: { list: PrListView }) {
  const cut = list.total > list.rows.length;
  return (
    <section className="pr-list" data-role="pr-list" aria-label={list.name}>
      <h2>
        <span className="name">{list.name}</span>
        <span className="n" data-role="pr-count">
          {list.rows.length} of {list.total}
        </span>
        {cut && list.url && (
          <a className="more" href={list.url} target="_blank" rel="noreferrer" data-role="pr-all">
            All {list.total} on GitHub ↗
          </a>
        )}
      </h2>
      {list.error && <p className="pr-error">{list.error}</p>}
      {list.rows.length > 0 && (
        <div className="pr-rows">
          {list.rows.map((row) => (
            <Row key={row.url} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One PR: its title, then where it is on GitHub, then who opened it and when it last moved. */
function Row({ row }: { row: PrRow }) {
  useClock();
  const name = row.repo.split("/")[1] ?? row.repo;
  return (
    <div className="pr-row" data-role="pr-row">
      <span className="title">{row.title}</span>
      <span className="where">
        <a href={row.url} target="_blank" rel="noreferrer" title={`Open ${row.repo}#${row.number} on GitHub`}>
          {name} #{row.number} <span className="ext">↗</span>
        </a>
        <span className="sub">
          {row.author}
          {row.updatedAt && <span title={row.updatedAt}> · {age(row.updatedAt)} ago</span>}
        </span>
      </span>
    </div>
  );
}
