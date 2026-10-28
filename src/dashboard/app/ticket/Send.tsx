import { useEffect, useRef, useState, type RefObject } from "react";
import type { TicketDetail } from "../../../api/views.ts";
import { showNotice } from "../notice.tsx";
import { message, pullTrigger } from "./ticket.ts";

/**
 * What Send here opens on a station (LASSO-197): optional instructions, and "Use Route <name>" pre-ticked for each
 * declared Route of the current Stage that goes to this one, showing what it adds to the prompt. Unticked, the send
 * carries only the human's words. A human's send never counts against a Route Budget, so no Route is marked as one
 * that would Flag. Cancel, Escape or a click outside `within` closes it without sending.
 */
export function SendPopover({ ticket: t, stage, within, onSent, onClose }: { ticket: TicketDetail; stage: string; within: RefObject<HTMLElement | null>; onSent: () => Promise<void>; onClose: () => void }) {
  const routes = (t.send?.routes ?? []).filter((r) => r.to === stage);
  const [route, setRoute] = useState<string | null>(routes[0]?.name ?? null);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
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

  const label = t.stages.find((s) => s.name === stage)?.label ?? stage;
  const send = async () => {
    setBusy(true);
    try {
      await pullTrigger(t.id, "send", { stage, ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(route ? { route } : {}) });
      onClose();
      await onSent();
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="send-pop" role="dialog" aria-label={`Send to ${label}`} data-role="send-pop">
      <strong>{`Send to ${label}`}</strong>
      <span>{stage === t.stage.name ? "The Stage starts over on a new Visit" : "A new Visit starts there"}; your instructions reach its prompt.</span>
      {routes.map((r) => (
        <div key={r.name} className="send-route" data-role="send-route">
          <label>
            <input type="checkbox" checked={route === r.name} onChange={() => setRoute((was) => (was === r.name ? null : r.name))} />
            <span>{`Use Route ${r.name}`}</span>
          </label>
          {r.text && <blockquote data-role="send-route-text">{(r.replaces ? "Replaces the prompt with: " : "Adds to the prompt: ") + r.text}</blockquote>}
        </div>
      ))}
      <textarea aria-label="Instructions" placeholder="Instructions (optional)" rows={3} value={instructions} onChange={(ev) => setInstructions(ev.target.value)} />
      <div className="send-actions">
        <button type="button" className="sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sm primary" data-role="send-confirm" disabled={busy} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  );
}
