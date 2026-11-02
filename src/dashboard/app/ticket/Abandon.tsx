import { useEffect, useRef, useState, type RefObject } from "react";
import type { PrView } from "../../../api/views.ts";

/** The Ticket's open Owned PRs: the ones Abandon may close (LASSO-169). */
export const closable = (prs: PrView[]): PrView[] => prs.filter((p) => p.role === "owned" && p.state !== "MERGED" && p.state !== "CLOSED");

/**
 * What pressing Abandon opens: the heading, what is kept, and a box per open Owned PR, all ticked. Confirm sends the
 * ticked URLs; Cancel, Escape or a click outside `within` (the lever and this popover) closes it without abandoning.
 */
export function AbandonPopover({ prs, within, busy, onConfirm, onClose }: { prs: PrView[]; within: RefObject<HTMLElement | null>; busy: boolean; onConfirm: (close: string[]) => void; onClose: () => void }) {
  const open = closable(prs);
  const [ticked, setTicked] = useState(() => new Set(open.map((p) => p.url)));
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    const away = (ev: PointerEvent) => {
      if (!within.current?.contains(ev.target as Node)) latestClose.current();
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") latestClose.current();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [within]);

  const toggle = (url: string) =>
    setTicked((s) => {
      const next = new Set(s);
      if (!next.delete(url)) next.add(url);
      return next;
    });
  // In the PRs' own order, whatever order the boxes were ticked in.
  const chosen = open.filter((p) => ticked.has(p.url)).map((p) => p.url);

  return (
    <div className="abandon-pop" role="dialog" aria-label="Abandon this Ticket?" data-role="abandon-pop">
      <strong>Abandon this Ticket?</strong>
      <span>The branch is kept. Ticked PRs are closed with a comment.</span>
      {open.map((p) => (
        <label key={p.url} data-role="abandon-pr">
          <input type="checkbox" checked={ticked.has(p.url)} onChange={() => toggle(p.url)} />
          <span>{`Close PR #${p.number} ${p.title}`}</span>
        </label>
      ))}
      <div className="abandon-actions">
        <button type="button" className="sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sm primary" data-role="abandon-confirm" disabled={busy} onClick={() => onConfirm(chosen)}>
          {open.length ? `Abandon, close ${chosen.length}` : "Abandon"}
        </button>
      </div>
    </div>
  );
}
