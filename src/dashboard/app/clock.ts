import { useSyncExternalStore } from "react";

let second = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    second++;
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Draws the component again each second, so times on screen (the Tick countdown, a Ledger row's last activity) move
 * without asking the server. One timer serves every component that uses it.
 */
export function useClock(): void {
  useSyncExternalStore(subscribe, () => second);
}
