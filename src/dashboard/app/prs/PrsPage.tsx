import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CheckCounts, PrListsView, PrListView, PrRow, Reviewer, ReviewerState } from "../../../api/views.ts";
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

/** The checks cell's words: what is failing or running, else how many passed; null when the PR has no checks. */
export function checksLabel(c: CheckCounts): string | null {
  const { passed = 0, failing = 0, running = 0, skipped = 0 } = c;
  const busy = [failing && `${failing} failing`, running && `${running} running`].filter(Boolean);
  if (busy.length) return busy.join(" · ");
  if (passed) return `${passed}/${passed} passed`;
  return skipped ? `${skipped} skipped` : null;
}

/** A list heading's freshness: "updated 4m ago", or "updated just now" inside the first minute. */
export function updatedLabel(fetchedAt: string, now: number = Date.now()): string {
  return now - new Date(fetchedAt).getTime() < 60_000 ? "updated just now" : `updated ${age(fetchedAt, now)} ago`;
}

/** A time of day in this browser's zone, as a clock face shows it: "3:40". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** How long a burst of changes is gathered before one re-read. */
const GATHER_MS = 100;

/** Grey rows held in a list's place before its first fetch, at most this many. */
const PLACEHOLDER_ROWS = 3;

/**
 * The Pull Requests page: each PR List from config.yaml, stacked in config order. Read on each visit, when config
 * changes, and when a list starts or finishes fetching. It also reads on every Tick: Lasso refreshes the lists only
 * while some tab keeps reading them.
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
  // A Ticket that changes may change which rows it links, its Stage or its Flag; a burst of changes, or a Tick's
  // start and end, reads once. After a reconnect ("hello") anything may have changed.
  const owed = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents(["ticket", "prlists", "tick", "hello"], () => {
    owed.current ??= setTimeout(() => {
      owed.current = null;
      void read();
    }, GATHER_MS);
  });
  useEffect(() => () => clearTimeout(owed.current ?? undefined), []);

  return (
    <div className="prs">
      <div className="ed-head">
        <h2>Pull Requests</h2>
      </div>
      {!view ? (
        <p className="note">Reading PR Lists…</p>
      ) : view.lists.length ? (
        view.lists.map((list) => <PrListBlock key={list.name} list={list} pausedUntil={view.pausedUntil} />)
      ) : (
        <p className="note">No PR Lists. Add some under pr_lists: in config.yaml, or on the Config page.</p>
      )}
    </div>
  );
}

/**
 * One PR List: its heading (name, "N of total", the link to the rest on GitHub, and how fresh it is), then its rows.
 * Before its first fetch, grey placeholder rows hold its place.
 */
function PrListBlock({ list, pausedUntil }: { list: PrListView; pausedUntil: string | null }) {
  const cut = list.total > list.rows.length;
  const waiting = list.fetchedAt === null && list.search !== null && !list.error;
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
        <Freshness list={list} pausedUntil={pausedUntil} />
      </h2>
      {list.error && <p className="pr-error">{list.error}</p>}
      {waiting && (
        <div className="pr-rows" data-role="pr-placeholders" aria-hidden="true">
          {Array.from({ length: Math.min(list.limit, PLACEHOLDER_ROWS) }, (_, i) => (
            <div key={i} className="pr-row placeholder" />
          ))}
        </div>
      )}
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

/**
 * How fresh a list is, at the heading's right: a spinner while it fetches, then "paused until 3:40, GitHub rate limit"
 * while GitHub points are low, else "updated 4m ago", moving as time passes.
 */
function Freshness({ list, pausedUntil }: { list: PrListView; pausedUntil: string | null }) {
  useClock();
  const words = pausedUntil ? `paused until ${clockTime(pausedUntil)}, GitHub rate limit` : list.fetchedAt ? updatedLabel(list.fetchedAt) : null;
  if (!words && !list.fetching) return null;
  return (
    <span className="age" data-role="pr-age" title={list.fetchedAt ?? undefined}>
      {list.fetching && <span className="spin" role="status" aria-label="refreshing" />}
      {words}
    </span>
  );
}

/** Each reviewer state's badge: its icon, tone and words. */
const BADGE: Record<ReviewerState, { icon: string; tone: string; label: string }> = {
  approved: { icon: "✓", tone: "good", label: "approved" },
  changes: { icon: "±", tone: "crit", label: "requested changes" },
  requested: { icon: "•", tone: "amber", label: "review requested" },
  rereview: { icon: "↻", tone: "amber", label: "needs re-review (dismissed or new commits)" },
  commented: { icon: "…", tone: "muted", label: "commented" },
};

/** A steady colour per name, behind initials. */
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** A reviewer as the hover list names them. */
const reviewerName = (r: Reviewer) => (r.kind === "hidden-team" ? "a team you can't see on GitHub" : r.kind === "team" ? `@${r.name}` : r.name);

/**
 * Overlapping avatars, worst state first, each badged with its state; hovering or focusing them lists every reviewer.
 * A click stops here, so it never reaches the row.
 */
function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  const pop = useId();
  if (!reviewers.length) return <span className="reviewers" />;
  return (
    <span className="reviewers" data-role="pr-reviewers" tabIndex={0} aria-label="Reviewers" aria-describedby={pop} onClick={(e) => e.stopPropagation()}>
      {reviewers.map((r, i) => {
        const b = BADGE[r.state];
        return (
          <span key={`${r.name ?? "?"}-${i}`} className={`rv-av ${r.kind}${r.required ? " req" : ""}`} style={{ zIndex: reviewers.length - i, ...(r.kind !== "hidden-team" && { background: `hsl(${hue(r.name ?? "")} 35% 32%)` }) }} data-role="pr-reviewer">
            {r.avatarUrl ? <Picture src={r.avatarUrl} initials={r.initials} /> : r.initials}
            <span className={`rv-badge ${b.tone}`} aria-hidden="true">
              {b.icon}
            </span>
          </span>
        );
      })}
      <span className="rv-pop" id={pop} role="tooltip">
        {reviewers.map((r, i) => {
          const b = BADGE[r.state];
          return (
            <span key={`${r.name ?? "?"}-${i}`} className="rv-line">
              <span className={`rv-badge ${b.tone}`} aria-hidden="true">
                {b.icon}
              </span>
              <b>{reviewerName(r)}</b> {b.label}
              {r.required && <span className="rv-req">required</span>}
            </span>
          );
        })}
        {reviewers.some((r) => r.required) && <span className="rv-note">Required reviewers must approve before merging.</span>}
      </span>
    </span>
  );
}

/** A person's GitHub picture, falling back to their initials when it won't load. */
function Picture({ src, initials }: { src: string; initials: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <>{initials}</> : <img src={src} alt="" onError={() => setFailed(true)} />;
}

/**
 * One PR: its verdict, its title over the verdict's reason, its reviewers, its checks, where it is on GitHub, who
 * opened it and when it last moved, then its Ticket and Stage. The title is the row's link, stretched over the whole
 * row: to the Ticket page, or to the PR on GitHub in a new tab when Lasso has no Ticket for it. The reviewers and the
 * "repo #n" link sit above it, so their clicks stay theirs.
 */
function Row({ row }: { row: PrRow }) {
  useClock();
  const name = row.repo.split("/")[1] ?? row.repo;
  const t = row.ticket;
  return (
    <div className="pr-row" data-role="pr-row">
      <span className={`pr-verdict ${row.verdict.tone}`} data-role="pr-verdict">
        {row.verdict.word}
      </span>
      <span className="main">
        {t ? (
          <a className="title" href={`#${t.id}`} data-role="pr-open" title={`Open ${t.ref}`}>
            {row.title}
          </a>
        ) : (
          <a className="title" href={row.url} target="_blank" rel="noreferrer" data-role="pr-open" title={`Open ${row.repo}#${row.number} on GitHub`}>
            {row.title}
          </a>
        )}
        <span className="sub">{row.verdict.reason}</span>
      </span>
      <Reviewers reviewers={row.reviewers} />
      <Checks checks={row.checks} />
      <span className="where">
        <a href={row.url} target="_blank" rel="noreferrer" title={`Open ${row.repo}#${row.number} on GitHub`}>
          {name} #{row.number} <span className="ext">↗</span>
        </a>
        <span className="sub">
          {row.author}
          {row.updatedAt && <span title={row.updatedAt}> · {age(row.updatedAt)} ago</span>}
        </span>
      </span>
      <span className="ticket" data-role="pr-ticket">
        {t && (
          <>
            <b title="Lasso Ticket">{t.ref}</b>
            <span className="sub">{t.stage}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** The worst group's icon, then the counts; an empty cell when the PR has no checks. */
function Checks({ checks }: { checks: CheckCounts }) {
  const label = checksLabel(checks);
  if (!label) return <span className="checks" />;
  const [icon, tone] = checks.failing ? ["✗", "crit"] : checks.running ? ["●", "run"] : checks.passed ? ["✓", "good"] : ["–", "muted"];
  const all = (["passed", "failing", "running", "skipped"] as const).filter((g) => checks[g]).map((g) => `${checks[g]} ${g}`);
  return (
    <span className="checks" data-role="pr-checks" title={all.join(", ")}>
      <span className={`icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      {label}
    </span>
  );
}
