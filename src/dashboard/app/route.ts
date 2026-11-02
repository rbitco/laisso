import { useEffect, useState } from "react";

/** What the page shows, from its hash: the Ledger (""), a Ticket ("#<id>", see Selection), Pull Requests ("#prs"), Pipelines ("#pipelines/<name>[/v<n>]"), or Config. */
export type Route =
  | { view: "ledger" }
  | { view: "prs" }
  /** A Ticket, with the Session or Stage its Session pane is pointed at, if any. */
  | { view: "detail"; id: string; select: Selection }
  /** The Pipeline open on the right, if any, and its frozen Version shown read-only, or null for its editor. */
  | { view: "pipelines"; name: string | null; version: number | null }
  | { view: "config" };

function decodeName(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** What a Ticket's Session pane is pointed at: a Session by id ("#<id>/sessions/<session>"), a Stage's newest ("#<id>/stages/<stage>"), or the live Session. */
export type Selection = { session: string } | { stage: string } | null;

/** The hash for a Ticket, pointed at a Session or a Stage when `select` says so. */
export function ticketHref(id: string, select: Selection = null): string {
  const base = "#" + encodeURIComponent(id);
  if (!select) return base;
  return "session" in select ? `${base}/sessions/${encodeURIComponent(select.session)}` : `${base}/stages/${encodeURIComponent(select.stage)}`;
}

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h === "config") return { view: "config" };
  if (h === "prs") return { view: "prs" };
  if (h === "pipelines" || h.startsWith("pipelines/")) {
    const rest = h.startsWith("pipelines/") ? decodeName(h.slice("pipelines/".length)) : null;
    const m = rest ? /^(.+)\/v(\d+)$/.exec(rest) : null;
    return { view: "pipelines", name: m ? m[1]! : rest || null, version: m ? Number(m[2]) : null };
  }
  if (!h) return { view: "ledger" };
  const m = /^([^/]+)\/(sessions|stages)\/(.+)$/.exec(h);
  if (!m) return { view: "detail", id: decodeName(h), select: null };
  const [, id, kind, name] = m;
  return { view: "detail", id: decodeName(id!), select: kind === "sessions" ? { session: decodeName(name!) } : { stage: decodeName(name!) } };
}

/** The route, and a count bumped each time it is visited, so the page shown reads everything afresh. */
export interface Place {
  route: Route;
  visit: number;
}

/** The page's place, following the hash; `reread` visits it again without moving. */
export function usePlace(): { place: Place; reread: () => void } {
  const [place, setPlace] = useState<Place>(() => ({ route: parseRoute(location.hash), visit: 1 }));
  useEffect(() => {
    const moved = () => setPlace((p) => ({ route: parseRoute(location.hash), visit: p.visit + 1 }));
    window.addEventListener("hashchange", moved);
    return () => window.removeEventListener("hashchange", moved);
  }, []);
  return { place, reread: () => setPlace((p) => ({ ...p, visit: p.visit + 1 })) };
}
