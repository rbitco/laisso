import { useEffect, useRef, useState } from "react";
import { GitPullRequest, ListChecks, Settings2, Workflow, type LucideIcon } from "lucide-react";
import type { DisplayState, PrListsStatus, TicketView } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { DevBadge } from "../header/DevBadge.tsx";
import { Tick } from "../header/Tick.tsx";
import { ThemeToggle } from "./Theme.tsx";

export type NavView = "ledger" | "prs" | "pipelines" | "config";

const VIEWS: { href: string; view: NavView; name: string; icon: LucideIcon }[] = [
  { href: "#", view: "ledger", name: "Tickets", icon: ListChecks },
  { href: "#prs", view: "prs", name: "Pull Requests", icon: GitPullRequest },
  { href: "#pipelines", view: "pipelines", name: "Pipelines", icon: Workflow },
  { href: "#config", view: "config", name: "Config", icon: Settings2 },
];

/** The display states that wait on a person. */
const NEEDS_YOU: DisplayState[] = ["needs_you", "flagged"];

/** How long Ticket changes are gathered before the count reads again, so a burst reads once. */
const GATHER_MS = 100;

/** How many active Tickets need you: read on load, after a burst of ticket events, and when Laisso comes back. */
function useNeedsYou(): number {
  const [count, setCount] = useState(0);
  const [reads, setReads] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    api<TicketView[]>("/api/tickets").then(
      (list) => live && setCount(list.filter((t) => NEEDS_YOU.includes(t.display.state)).length),
      () => undefined,
    );
    return () => void (live = false);
  }, [reads]);
  const gather = () => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      setReads((n) => n + 1);
    }, GATHER_MS);
  };
  useEvents(["ticket"], gather);
  // The first hello is the page connecting; a later one is Laisso back after a restart, and changes may have been missed.
  const everOpen = useRef(false);
  useEvents(["hello"], () => {
    if (everOpen.current) gather();
    everOpen.current = true;
  });
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  return count;
}

/**
 * Whether a PR List needs a look: gh is missing or logged out, or a list's last fetch failed. Read on load, after a
 * burst of prlists or config events, and when Laisso comes back. The status endpoint answers from the cache alone, so
 * reading it never counts as the Pull Requests page being open.
 */
function usePrListsFailing(): boolean {
  const [failing, setFailing] = useState(false);
  const [reads, setReads] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    api<PrListsStatus>("/api/pr-lists/status").then(
      (status) => live && setFailing(status.failing),
      () => undefined,
    );
    return () => void (live = false);
  }, [reads]);
  const gather = () => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      setReads((n) => n + 1);
    }, GATHER_MS);
  };
  useEvents(["prlists", "config"], gather);
  const everOpen = useRef(false);
  useEvents(["hello"], () => {
    if (everOpen.current) gather();
    everOpen.current = true;
  });
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  return failing;
}

/**
 * The page's nav: the name and dev badge, the four views with how many Tickets need you and an amber dot while a PR
 * List is failing, and
 * the Tick and theme button at the foot.
 * It is a sidebar; `compact` (a Ticket's page) shrinks it to an icon rail, and below 700px the views become a bottom
 * tab bar. `onChecked` follows a Check now, so the page reads again.
 */
export function Nav({ on, compact, onChecked }: { on: NavView; compact: boolean; onChecked: () => void }) {
  const needs = useNeedsYou();
  const prsFailing = usePrListsFailing();
  return (
    <nav className={"pages" + (compact ? " compact" : "")} aria-label="Pages" data-role="nav">
      <h1 className="brand">
        <a href="#" data-role="home">
          <span className="word">LAISSO</span>
          <span className="mark" aria-hidden="true">
            L
          </span>
        </a>
        <DevBadge />
      </h1>
      <div className="views">
        {VIEWS.map(({ href, view, name, icon: Icon }) => (
          <a key={view} href={href} className={view === on ? "on" : undefined} aria-current={view === on ? "page" : undefined} title={name}>
            <Icon aria-hidden="true" />
            <span className="label">{name}</span>
            {view === "ledger" && needs > 0 && (
              <span className="count" data-role="needs-you">
                <span className="n">{needs}</span>
                <span className="sr">{" need you"}</span>
              </span>
            )}
            {view === "prs" && prsFailing && (
              <span className="alert-dot" data-role="prs-failing" title="A PR List's last refresh failed">
                <span className="sr">{" a PR List's last refresh failed"}</span>
              </span>
            )}
          </a>
        ))}
      </div>
      <div className="foot">
        <Tick onChecked={onChecked} />
        <ThemeToggle />
      </div>
    </nav>
  );
}
