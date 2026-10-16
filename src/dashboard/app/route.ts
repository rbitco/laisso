import { useEffect, useState } from "react";

/** What the page shows, from its hash: the Ledger (""), a Ticket ("#<id>"), Pull Requests ("#prs"), Pipelines ("#pipelines/<name>[/v<n>]"), or Config. */
export type Route =
  | { view: "ledger" }
  | { view: "prs" }
  | { view: "detail"; id: string }
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

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h === "config") return { view: "config" };
  if (h === "prs") return { view: "prs" };
  if (h === "pipelines" || h.startsWith("pipelines/")) {
    const rest = h.startsWith("pipelines/") ? decodeName(h.slice("pipelines/".length)) : null;
    const m = rest ? /^(.+)\/v(\d+)$/.exec(rest) : null;
    return { view: "pipelines", name: m ? m[1]! : rest || null, version: m ? Number(m[2]) : null };
  }
  return h ? { view: "detail", id: decodeName(h) } : { view: "ledger" };
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
