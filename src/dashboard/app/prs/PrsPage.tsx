import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Columns2, Rows3, type LucideIcon } from "lucide-react";
import type { CheckCounts, GhProblem, PrListError, PrListsView, PrListView, PrRow, Reviewer, ReviewerState } from "../../../api/views.ts";
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

/** The page's two layouts: lists one under another in full rows, or side by side as wrapping columns. */
export type PrPageLayout = PrListsView["layout"];

/** Where this browser keeps the layout it picked; absent until the switch is first used. */
export const LAYOUT_KEY = "laisso.prLayout";

/** The layout this browser picked, or null when it hasn't (or its storage can't be read). */
function savedLayout(): PrPageLayout | null {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === "stacked" || saved === "side-by-side" ? saved : null;
  } catch {
    return null;
  }
}

/** Keep this browser's pick; a browser that can't store it keeps it for this visit only. */
function saveLayout(layout: PrPageLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* private window or storage blocked: not remembered */
  }
}

/** Stacked shows a bar of jump chips with more than this many lists. */
const CHIPS_OVER = 2;

/**
 * The Pull Requests page: each PR List from config.yaml, in config order, stacked or side by side. Read on each visit,
 * when config changes, and when a list starts or finishes fetching. It also reads on every Tick: Laisso refreshes the
 * lists only while some tab keeps reading them. The layout is this browser's own pick once it has made one, else
 * pr_page_layout from config.
 */
export function PrsPage({ visit }: { visit: number }) {
  const [view, setView] = useState<PrListsView | null>(null);
  const [picked, setPicked] = useState<PrPageLayout | null>(savedLayout);
  const layout = picked ?? view?.layout ?? "stacked";
  const pick = (next: PrPageLayout) => {
    setPicked(next);
    saveLayout(next);
  };
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
  const shown = view?.lists.filter((list) => !list.hidden) ?? [];
  const hidden = view?.lists.filter((list) => list.hidden) ?? [];
  const chips = layout === "stacked" && shown.length > CHIPS_OVER;

  return (
    <div className="prs">
      <div className="ed-head">
        <h2>Pull Requests</h2>
      </div>
      {!view ? (
        <p className="note">Reading PR Lists…</p>
      ) : !view.lists.length ? (
        <NoLists example={view.example} />
      ) : view.ghProblem ? (
        <GhNotice problem={view.ghProblem} />
      ) : (
        <>
          <div className={"pr-top" + (chips ? " has-chips" : "")} data-role="pr-top">
            {chips ? <JumpChips lists={shown} /> : <span />}
            <LayoutSwitch layout={layout} onPick={pick} />
          </div>
          <div className={`pr-lists ${layout}`} data-role="pr-lists" data-layout={layout}>
            {shown.map((list, i) => (
              <PrListBlock key={list.name} list={list} anchor={listAnchor(i)} pausedUntil={view.pausedUntil} />
            ))}
          </div>
          {hidden.length > 0 && (
            <p className="note pr-hidden" data-role="pr-hidden" title="hide_when_empty is set on these lists in config.yaml">
              {hidden.length === 1 ? "1 empty list hidden" : `${hidden.length} empty lists hidden`}: {hidden.map((list) => list.name).join(", ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The element id a list's jump chip scrolls to; by position, as a list's name may hold anything. */
const listAnchor = (i: number) => `pr-list-${i}`;

/** Stacked or Side by side, as a two-option segmented control; hidden on phones, where both are one stack of cards. */
function LayoutSwitch({ layout, onPick }: { layout: PrPageLayout; onPick: (layout: PrPageLayout) => void }) {
  const option = (value: PrPageLayout, label: string, title: string, Icon: LucideIcon) => (
    <button type="button" role="radio" aria-checked={layout === value} title={title} onClick={() => onPick(value)}>
      <Icon aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div className="pr-seg" role="radiogroup" aria-label="Layout" data-role="pr-layout">
      {option("stacked", "Stacked", "Lists one under another, full rows", Rows3)}
      {option("side-by-side", "Side by side", "Lists side by side as columns of cards", Columns2)}
    </div>
  );
}

/** A chip per list, naming it with the count of rows it shows, that scrolls the page to that list. */
function JumpChips({ lists }: { lists: PrListView[] }) {
  return (
    <nav className="pr-chips" aria-label="PR Lists" data-role="pr-chips">
      {lists.map((list, i) => (
        <button key={list.name} type="button" onClick={() => document.getElementById(listAnchor(i))?.scrollIntoView?.({ block: "start" })}>
          {list.name}
          {list.fetchedAt !== null && <span className="n">{list.rows.length}</span>}
        </button>
      ))}
    </nav>
  );
}

/** What stands in for every list while gh cannot search: the problem, and the fix. */
function GhNotice({ problem }: { problem: GhProblem }) {
  return (
    <div className="card problem pr-problem" data-role="pr-gh-problem" role="alert">
      <b>{problem.kind === "gh-missing" ? "gh is not installed, so Laisso cannot search GitHub." : "gh is not logged in, so Laisso cannot search GitHub."}</b>
      <span>
        {problem.kind === "gh-missing" ? (
          "Install gh from cli.github.com, then restart Laisso"
        ) : (
          <>
            Run <code>gh auth login</code>, then Check now
          </>
        )}
      </span>
    </div>
  );
}

/** pr_lists: {} — no lists, and the defaults as the example to start from. */
function NoLists({ example }: { example: string | null }) {
  return (
    <div className="pr-none" data-role="pr-none">
      <p className="note">No PR Lists. Add them under pr_lists in config.yaml</p>
      {example && <pre className="pr-example">{example}</pre>}
    </div>
  );
}

/** A message with its first letter capitalised, to stand as a sentence of its own. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One PR List: its heading (name, "N of total", the link to the rest on GitHub, and how fresh it is), then its rows.
 * Before its first fetch, grey placeholder rows hold its place. A list that cannot search, whose query GitHub rejected,
 * or that has failed before any good fetch shows why in place of rows; a failure after a good fetch keeps the rows and
 * says so in the heading. A list with no PRs says so, linking the same search on GitHub.
 */
function PrListBlock({ list, anchor, pausedUntil }: { list: PrListView; anchor: string; pausedUntil: string | null }) {
  const cut = list.total > list.rows.length;
  const blocked = list.error !== null && list.fetchedAt === null;
  const waiting = list.fetchedAt === null && list.search !== null && !list.error;
  const empty = list.fetchedAt !== null && list.error?.kind !== "rejected" && list.rows.length === 0;
  return (
    <section className="pr-list" id={anchor} data-role="pr-list" aria-label={list.name}>
      <h2>
        <span className="name">{list.name}</span>
        {!blocked && (
          <span className="n" data-role="pr-count">
            {list.rows.length} of {list.total}
          </span>
        )}
        {cut && list.url && (
          <a className="more" href={list.url} target="_blank" rel="noreferrer" data-role="pr-all">
            All {list.total} on GitHub ↗
          </a>
        )}
        <Freshness list={list} pausedUntil={pausedUntil} />
      </h2>
      {blocked && list.error && <ListProblem list={list} error={list.error} />}
      {empty && (
        <p className="note pr-empty" data-role="pr-empty">
          No PRs match
          {list.url && (
            <>
              {" · "}
              <a href={list.url} target="_blank" rel="noreferrer">
                Search on GitHub ↗
              </a>
            </>
          )}
        </p>
      )}
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
 * Why a list has no rows to show, in the error styling: no configured repo is on GitHub; GitHub rejected the query,
 * with its message, the search as sent and where to fix it; or the fetch failed before any good one.
 */
function ListProblem({ list, error }: { list: PrListView; error: PrListError }) {
  return (
    <div className="card problem pr-problem" data-role="pr-error" data-kind={error.kind}>
      {error.kind === "no-github-repos" ? (
        <span>{sentence(error.message)}</span>
      ) : error.kind === "rejected" ? (
        <>
          <b>GitHub rejected this query: {error.message}</b>
          {list.search && <pre data-role="pr-search">{list.search}</pre>}
          <span className="why">Fix it under pr_lists in config.yaml</span>
        </>
      ) : (
        <>
          <b>Couldn't fetch this list: {error.message}</b>
          <span className="why">Laisso tries again at the next refresh.</span>
        </>
      )}
    </div>
  );
}

/**
 * How fresh a list is, at the heading's right: a spinner while it fetches, then "paused until 3:40, GitHub rate limit"
 * while GitHub points are low, else "updated 4m ago", moving as time passes. When a refresh after a good fetch failed,
 * it turns amber and adds why.
 */
function Freshness({ list, pausedUntil }: { list: PrListView; pausedUntil: string | null }) {
  useClock();
  const failed = !pausedUntil && list.fetchedAt !== null && (list.error?.kind === "failed" || list.error?.kind === "rate-limited") ? list.error : null;
  const words = pausedUntil ? `paused until ${clockTime(pausedUntil)}, GitHub rate limit` : list.fetchedAt ? updatedLabel(list.fetchedAt) + (failed ? ` · last refresh failed: ${failed.message}` : "") : null;
  if (!words && !list.fetching) return null;
  return (
    <span className={failed ? "age failed" : "age"} data-role="pr-age" title={list.fetchedAt ?? undefined}>
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
 * opened it and when it last moved, then its Ticket and Stage, then a "ref:" chip for each Ticket that references it. The title is the row's link, stretched over the whole
 * row: to the Ticket page, or to the PR on GitHub in a new tab when Laisso has no Ticket for it. The reviewers and the
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
          <span className="owner">
            <b title="Laisso Ticket">{t.ref}</b>
            <span className="sub">{t.stage}</span>
          </span>
        )}
        {row.refs.map((r) => (
          <a key={r.id} className="ref" href={`#${r.id}`} data-role="pr-ref" title={`Open ${r.ref}, which references this PR`}>
            ref: <b>{r.ref}</b> <span className="sub">{r.stage}</span>
          </a>
        ))}
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
