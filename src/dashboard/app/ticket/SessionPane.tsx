import { useEffect, useRef, useState } from "react";
import type { FeedbackView, SessionView, TicketDetail } from "../../../api/views.ts";
import { duration, relative, sessionProfile } from "../../metro.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { message, ticketRoute } from "./ticket.ts";

export const sessionLabel = (s: SessionView) => s.stage + " #" + s.ordinal + (s.round ? " · Round " + s.round : "");

/** Done and Abandon remove the worktree; the path stays on the Ticket as history. */
export const worktreeGone = (t: TicketDetail) => t.state !== "active";

/** A button showing a path or id's name; a press copies it, or shows it where the clipboard is refused. */
function CopyChip({ label, value }: { label: string; value: string }) {
  const [shown, setShown] = useState(label);
  useEffect(() => {
    if (shown === label) return;
    const timer = setTimeout(() => setShown(label), 1500);
    return () => clearTimeout(timer);
  }, [shown, label]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setShown("copied");
    } catch {
      setShown(value);
    }
  };
  return (
    <button type="button" title={value} onClick={() => void copy()}>
      {shown}
    </button>
  );
}

const WorktreeChip = ({ ticket: t }: { ticket: TicketDetail }) =>
  worktreeGone(t) ? (
    <span className="muted" title={t.worktree}>
      worktree removed
    </span>
  ) : (
    <CopyChip label="worktree" value={t.worktree} />
  );

/** The Feedback a Round addressed: one line per item, with the evidence it was addressed or "open". */
function FeedbackList({ items }: { items: FeedbackView[] }) {
  if (!items.length) return null;
  return (
    <div className="feedback" data-role="feedback">
      <h4>Feedback</h4>
      {items.map((f) => (
        <div key={f.kind + f.id} className="row">
          <span className={"pill " + (f.addressed ? "succeeded" : "flagged")}>{f.addressed ? "addressed" : "open"}</span>
          <span className="kind">{f.kind}</span>
          {f.url ? (
            <a href={f.url} target="_blank" rel="noopener">
              {f.summary}
            </a>
          ) : (
            <span>{f.summary}</span>
          )}
          <span className="meta">{f.addressed || ""}</span>
        </div>
      ))}
    </div>
  );
}

/** How long a Session has run: ticking each second while it runs, else as the server measured it. */
function Duration({ session: s }: { session: SessionView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!s.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.running]);
  return (
    <span className="meta" data-role="duration">
      {duration(s.running ? now - new Date(s.startedAt).getTime() : s.durationMs)}
    </span>
  );
}

/**
 * The latest Session: its header, Stop, Take over or Open terminal while it runs, the agent's words, its stdout behind a button, and the paths to
 * copy. `refresh` follows a Stop or Open terminal that went through.
 */
export function SessionPane({ ticket: t, session: s, refresh }: { ticket: TicketDetail; session: SessionView; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [stdout, setStdout] = useState(false);
  const outcome = s.running ? "running" : s.outcome || "unknown";
  const profile = sessionProfile(s);
  const post = async (route: string, body?: string) => {
    setBusy(true);
    try {
      await api(route, { method: "POST", body });
      await refresh();
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(false);
    }
  };
  const sessionRoute = ticketRoute(t.id) + "/sessions/" + s.id;

  const head = (
    <div className="head">
      <span className={"pill " + outcome}>{outcome + (s.endedReason ? " · " + s.endedReason : "")}</span>
      <strong>{sessionLabel(s)}</strong>
      <span className="meta">{s.mode + " · " + s.startedBy}</span>
      <Duration session={s} />
      <span className="meta">{s.costUsd === null ? "" : "$" + s.costUsd.toFixed(2)}</span>
      {profile ? (
        <span className="meta" data-role="profile" title={profile.title}>
          {profile.text}
        </span>
      ) : (
        <span />
      )}
      <span className="meta">{"started " + relative(s.startedAt)}</span>
      {s.running && s.mode === "headless" && (
        <button className="stop" type="button" disabled={busy} onClick={() => void post(sessionRoute + "/stop")}>
          Stop
        </button>
      )}
      {s.running && s.mode === "headless" && t.triggers.some((x) => x.action === "takeover" && !x.unavailable) && (
        <button className="stop" type="button" disabled={busy} title="Stop this run and continue its session in a terminal" onClick={() => void post(ticketRoute(t.id) + "/takeover", "{}")}>
          Take over
        </button>
      )}
      {s.mode === "terminal" && s.running && t.triggers.some((x) => x.action === "terminal") && (
        <button className="stop" type="button" disabled={busy} onClick={() => void post(ticketRoute(t.id) + "/terminal", "{}")}>
          Open terminal
        </button>
      )}
      {s.mode === "terminal" && s.running && t.triggers.some((x) => x.action === "handback") && (
        <button className="stop" type="button" disabled={busy} title="End this terminal Session and let Lasso run the Stage again" onClick={() => void post(ticketRoute(t.id) + "/handback", "{}")}>
          Hand back
        </button>
      )}
    </div>
  );

  if (s.mode === "terminal") {
    const opened = s.openedAt ? "terminal opened " + relative(s.openedAt) : "not opened yet";
    return (
      <section className="session" data-role="session">
        {head}
        <div className="hint">{opened + ". Lasso tracks this Session by its id only: the row ends when you mark the Stage done or skip it" + (t.triggers.some((x) => x.action === "handback") ? ", or hand it back to Lasso." : ".")}</div>
        <div className="paths">
          <WorktreeChip ticket={t} />
          <CopyChip label="session id" value={s.id} />
          {s.runnerSessionId ? <CopyChip label="runner session" value={s.runnerSessionId} /> : <span />}
          {s.transcriptPath ? <CopyChip label="transcript" value={s.transcriptPath} /> : <span />}
        </div>
      </section>
    );
  }
  const final = (
    <div className={"final" + (s.outcome === "succeeded" ? " ok" : "")} hidden={!s.finalMessage}>
      {s.finalMessage || ""}
    </div>
  );
  // A built-in action has no output; an Action from config is a command, and its output reads like a Runner's.
  if (s.mode === "action" && !s.stdoutPath) {
    return (
      <section className="session" data-role="session">
        {head}
        <div className="hint">Lasso performed this Stage itself; there is no Runner output.</div>
        {final}
      </section>
    );
  }
  return (
    <section className="session" data-role="session">
      {head}
      <FeedbackList items={s.feedback} />
      <Words session={s} />
      <div className="paths">
        {s.stdoutPath && (
          <button type="button" className="stdout-open" data-role="stdout-open" onClick={() => setStdout(true)}>
            {s.running ? "View stdout (live)" : "View stdout"}
          </button>
        )}
        <WorktreeChip ticket={t} />
        {s.runnerSessionId ? <CopyChip label="runner session" value={s.runnerSessionId} /> : <span />}
        {s.transcriptPath ? <CopyChip label="transcript" value={s.transcriptPath} /> : <span />}
      </div>
      {stdout && <StdoutModal ticket={t} session={s} onClose={() => setStdout(false)} />}
    </section>
  );
}

/**
 * What the agent said: its Latest Message while the Session runs; once it ends, the final message, with the agent's
 * last words beneath when they differ from it.
 */
function Words({ session: s }: { session: SessionView }) {
  if (s.running) {
    return (
      <div className="words" data-role="words">
        <div className="words-label">
          <span className="live-dot" />
          Latest Message
        </div>
        <div className="words-text" data-role="latest">
          {s.latestMessage ?? <span className="dim">{s.mode === "action" ? "Waiting for the first line of output…" : "Waiting for the agent's first message…"}</span>}
        </div>
      </div>
    );
  }
  const differs = s.latestMessage !== null && s.latestMessage.trim() !== (s.finalMessage ?? "").trim();
  return (
    <div className="words" data-role="words">
      <div className="words-label">Final message</div>
      <div className={"words-text" + (s.outcome === "succeeded" ? " ok" : "")} data-role="final">
        {s.finalMessage ?? <span className="dim">No final message.</span>}
      </div>
      {differs && (
        <>
          <div className="words-label">Agent's last words</div>
          <div className="words-text dim" data-role="last-words">
            {s.latestMessage}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A Session's raw stdout in a modal near the size of the window, tailed live while the Session runs. Escape, Close or
 * a click on the backdrop closes it.
 */
function StdoutModal({ ticket: t, session: s, onClose }: { ticket: TicketDetail; session: SessionView; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    if (!el.open) el.showModal();
    return () => el.close();
  }, []);
  const outcome = s.running ? "running" : s.outcome || "unknown";
  return (
    <dialog
      ref={dialog}
      className="modal stdout-modal"
      data-role="stdout"
      aria-label={sessionLabel(s) + " stdout"}
      onCancel={(ev) => {
        ev.preventDefault();
        onClose();
      }}
      onClick={(ev) => ev.target === dialog.current && onClose()}
    >
      <section className="session">
        <div className="head">
          <span className={"pill " + outcome}>{outcome}</span>
          <strong>{sessionLabel(s) + " · stdout"}</strong>
          <span className="meta path">{s.stdoutPath}</span>
          <span className="paths">
            <CopyChip label="copy path" value={s.stdoutPath!} />
            <button type="button" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        <Output ticket={t.id} session={s.id} running={s.running} />
      </section>
    </dialog>
  );
}

/**
 * A Session's output, read from where the last read stopped: once on show, again on each "stdout" event for it while
 * it runs, and once more as it ends to catch the last of it. An event while a read is out asks for one more after it.
 */
function Output({ ticket, session, running }: { ticket: string; session: string; running: boolean }) {
  const out = useRef<HTMLPreElement>(null);
  const tail = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let offset = 0;
    let reading = false;
    let again = false;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const chunk = await api<{ text: string; offset: number }>(ticketRoute(ticket) + "/sessions/" + session + "/stdout?offset=" + offset);
        if (!live) return;
        if (chunk.text) showOutput(out.current!, chunk.text);
        offset = chunk.offset;
      } catch (error) {
        if (live) showOutput(out.current!, "\n[stdout unavailable: " + message(error) + "]");
      } finally {
        reading = false;
      }
      if (again && live) {
        again = false;
        void read();
      }
    };
    tail.current = () => void read();
    void read();
    return () => {
      live = false;
      tail.current = () => {};
    };
  }, [ticket, session]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) tail.current();
    wasRunning.current = running;
  }, [running]);
  useEvents(["stdout"], (event) => {
    if (running && parse(event)?.session === session) tail.current();
  });
  return <pre ref={out} />;
}

const parse = (event: MessageEvent<string>): { session?: string; ticket?: string } | null => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

// Runner output keeps only its newest OUTPUT_TAIL characters on the page: appending to one big text node re-laid out
// megabytes every second. The whole log stays at the stdout path.
const OUTPUT_TAIL = 200000;

/** Appends text to the output, trimming its oldest text past OUTPUT_TAIL and saying so, and follows the end if it was there. */
export function showOutput(out: HTMLPreElement, text: string): void {
  const pinned = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
  if (text.length > OUTPUT_TAIL) {
    text = text.slice(-OUTPUT_TAIL);
    out.replaceChildren();
    out.dataset.shown = "0";
    out.dataset.trimmed = "";
  }
  out.append(text);
  let shown = Number(out.dataset.shown || 0) + text.length;
  while (shown > OUTPUT_TAIL) {
    const first = out.firstChild as Text;
    const excess = shown - OUTPUT_TAIL;
    if (first.length <= excess) {
      out.removeChild(first);
      shown -= first.length;
    } else {
      first.deleteData(0, excess);
      shown = OUTPUT_TAIL;
    }
    out.dataset.trimmed = "";
  }
  out.dataset.shown = String(shown);
  if (pinned) out.scrollTop = out.scrollHeight;
}
