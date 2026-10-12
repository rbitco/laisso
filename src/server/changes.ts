/** Something the dashboard shows has changed: a Ticket (its row, Sessions or Feedback), a Session's stdout, the tick, or config.yaml through /api. */
export type Change = { kind: "ticket"; ticket: string } | { kind: "stdout"; ticket: string; session: string } | { kind: "tick" } | { kind: "config" };

/**
 * The one place writes announce themselves, so the dashboard can be pushed
 * to instead of polling. Listeners are told after the write is committed;
 * a listener that throws is dropped from that one notice, never the write.
 */
export class Changes {
  private listeners = new Set<(change: Change) => void>();
  private closers = new Set<() => void>();
  private closed = false;

  emit(change: Change): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A broken listener must not fail the write that announced itself.
      }
    }
  }

  /** Listen until the returned function is called, or until `close`, which calls `onClose`. */
  subscribe(listener: (change: Change) => void, onClose: () => void = () => undefined): () => void {
    if (this.closed) {
      onClose();
      return () => undefined;
    }
    this.listeners.add(listener);
    this.closers.add(onClose);
    return () => {
      this.listeners.delete(listener);
      this.closers.delete(onClose);
    };
  }

  /** Shutdown: every subscriber is told to finish, so open event streams do not hold the server open. */
  close(): void {
    this.closed = true;
    const closers = [...this.closers];
    this.listeners.clear();
    this.closers.clear();
    for (const close of closers) close();
  }
}
