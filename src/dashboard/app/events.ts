import { useEffect, useRef } from "react";

let source: EventSource | null = null;

/**
 * The page's one connection to /api/events, opened by the first component that listens and shared by all of them.
 * Each event names what changed, never the data; a "hello" after the first means Lasso came back and anything may
 * have changed. EventSource reconnects on its own after a restart.
 */
export function events(): EventSource {
  source ??= new EventSource("/api/events");
  return source;
}

/** Calls `react` with each of the named events while the component is mounted; `event.data` is the event's JSON. */
export function useEvents(kinds: string[], react: (event: MessageEvent<string>) => void): void {
  const latest = useRef(react);
  latest.current = react;
  const key = kinds.join(" ");
  useEffect(() => {
    const target = events();
    const listener = (event: Event) => latest.current(event as MessageEvent<string>);
    const names = key.split(" ");
    for (const kind of names) target.addEventListener(kind, listener);
    return () => {
      for (const kind of names) target.removeEventListener(kind, listener);
    };
  }, [key]);
}
