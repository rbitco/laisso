import { useEffect, useRef, useState, type RefObject } from "react";
import type { MarkDoneView, TicketDetail } from "../../../api/views.ts";
import { SendPopover } from "./Send.tsx";

const WALK = "walk";

/**
 * The Mark done menu on a human or taken-over Stage (LASSO-198): "Done, walk forward", "Done via <route> -> <target>"
 * for each declared Route with its text and an optional note, and "Send to Stage…", which opens the Send popover for
 * the Stage picked. The terminal agent's pick is pre-selected with its note; whatever is confirmed is a human's choice,
 * so no Route is marked as one that would Flag. Only walking forward checks the artifact. Cancel, Escape or a click
 * outside `within` closes it.
 */
export function MarkDoneMenu({ ticket: t, menu, within, busy, onDone, onSent, onClose }: { ticket: TicketDetail; menu: MarkDoneView; within: RefObject<HTMLElement | null>; busy: boolean; onDone: (body: object) => void; onSent: () => Promise<void>; onClose: () => void }) {
  const suggested = menu.suggested && menu.routes.some((r) => r.name === menu.suggested!.route) ? menu.suggested : null;
  const [choice, setChoice] = useState<string>(suggested?.route ?? WALK);
  const [note, setNote] = useState(suggested?.note ?? "");
  const [sending, setSending] = useState<string | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    if (sending) return;
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
  }, [within, sending]);

  if (sending) return <SendPopover ticket={t} stage={sending} within={within} onSent={onSent} onClose={onClose} />;

  const pick = (value: string) => {
    setChoice(value);
    setNote(value === suggested?.route ? (suggested.note ?? "") : "");
  };
  const label = (stage: string) => t.stages.find((s) => s.name === stage)?.label ?? stage;
  const confirm = () => onDone(choice === WALK ? {} : { route: choice, ...(note.trim() ? { note: note.trim() } : {}) });
  const unavailable = t.send?.unavailable ?? null;

  return (
    <div className="send-pop done-pop" role="dialog" aria-label={`Mark ${t.stage.name} done`} data-role="done-pop">
      <strong>{`Mark ${t.stage.name} done`}</strong>
      <label>
        <input type="radio" name="done-exit" checked={choice === WALK} onChange={() => pick(WALK)} />
        <span>Done, walk forward</span>
      </label>
      {menu.routes.map((r) => (
        <div key={r.name} className="send-route" data-role="done-route">
          <label>
            <input type="radio" name="done-exit" checked={choice === r.name} onChange={() => pick(r.name)} />
            <span>{`Done via ${r.name} -> ${label(r.to)}`}</span>
          </label>
          {suggested?.route === r.name && <em data-role="done-suggested">the agent's pick</em>}
          {r.text && <blockquote data-role="done-route-text">{(r.replaces ? "Replaces the prompt with: " : "Adds to the prompt: ") + r.text}</blockquote>}
        </div>
      ))}
      {choice !== WALK && <textarea aria-label="Note" placeholder="Note (optional)" rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} />}
      <select aria-label="Send to Stage" value="" disabled={!!unavailable || !t.send} title={unavailable ?? undefined} onChange={(ev) => ev.target.value && setSending(ev.target.value)}>
        <option value="">Send to Stage…</option>
        {t.stages.map((s) => (
          <option key={s.name} value={s.name}>
            {s.label}
          </option>
        ))}
      </select>
      <div className="send-actions">
        <button type="button" className="sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sm primary" data-role="done-confirm" disabled={busy} onClick={confirm}>
          {choice === WALK ? "Done, walk forward" : `Done via ${choice}`}
        </button>
      </div>
    </div>
  );
}
