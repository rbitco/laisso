import { useEffect, useRef } from "react";

let source: EventSource | null = null;

/**
 * The page's one connection to /api/events, shared by the old script and React. Each event names what
 * changed, never the data; a "hello" after the first means Lasso came back and anything may have changed.
 */
export function events(): EventSource {
  source ??= new EventSource("/api/events");
  return source;
}

/** Calls `react` on each of the named events while the component is mounted. */
export function useEvents(kinds: string[], react: () => void): void {
  const latest = useRef(react);
  latest.current = react;
  const key = kinds.join(" ");
  useEffect(() => {
    const target = events();
    const listener = () => latest.current();
    const names = key.split(" ");
    for (const kind of names) target.addEventListener(kind, listener);
    return () => {
      for (const kind of names) target.removeEventListener(kind, listener);
    };
  }, [key]);
}
