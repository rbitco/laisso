import { useSyncExternalStore } from "react";

let message = "";
const listeners = new Set<() => void>();

/** Puts a save or an error on the line at the top of the page; an empty message hides it. */
export function showNotice(next: string): void {
  message = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The line at the top of the page that reports a save or an error, hidden while there is nothing to say. */
export function Notice() {
  const text = useSyncExternalStore(subscribe, () => message);
  return (
    <p data-role="notice" className="notice" hidden={!text}>
      {text}
    </p>
  );
}
