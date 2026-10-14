import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import type { ConfigFile, IntakeResult, PipelineListing } from "../../../api/views.ts";
import type { RepoConfig } from "../../../server/config.ts";
import type { Detection } from "../../../intake/detect.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { message } from "../ticket/ticket.ts";
import { pipelineLine } from "../../metro.ts";

/** What was pasted and what Lasso detected in it, waiting on the person to confirm. */
export interface Detected {
  input: string;
  detection: Detection;
}

const detect = (input: string, repo?: string) => api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input, repo }) });

/**
 * The header's one input: paste a JIRA key or a GitHub issue, or type a prompt; Lasso says what it found before adding.
 * Busy while Lasso looks the input up, which can take a few seconds for a tracker reference.
 */
export function IntakeForm({ text, onText, onDetected }: { text: string; onText: (text: string) => void; onDetected: (detected: Detected) => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const input = text.trim();
    if (!input || busy) return;
    showNotice("");
    setBusy(true);
    try {
      onDetected({ input, detection: await detect(input) });
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form data-role="intake" autoComplete="off" onSubmit={submit} aria-busy={busy}>
      <input name="input" placeholder="Paste a JIRA key, a GitHub issue, or type a prompt" aria-label="Intake" value={text} readOnly={busy} onChange={(ev) => onText(ev.target.value)} />
      <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy}>
        {busy ? "Looking up" : "Import"}
      </button>
    </form>
  );
}

interface Option {
  value: string;
  /** What the row says under its name: a repo's tracker and path, a Pipeline's Stages. */
  detail?: ReactNode;
  /** Drawn beside the name: a Pipeline's line of Stages. */
  figure?: ReactNode;
  tag?: string | null;
}

/**
 * One choice from a short list, every option in view: a row each, the chosen one marked as the Ledger marks its
 * selected row. Radio inputs underneath, so arrow keys move the choice. Nothing is chosen until Lasso suggests or
 * the person picks.
 */
function Picker({ name, label, options, value, disabled, onChange, empty, children }: { name: string; label: string; options: Option[]; value: string; disabled: boolean; onChange: (value: string) => void; empty?: ReactNode; children?: ReactNode }) {
  return (
    <fieldset className="picker" data-role={`pick-${name}`} disabled={disabled}>
      <legend>{label}</legend>
      {options.length === 0 && <p className="opts-empty">{empty}</p>}
      <div className="opts" role="radiogroup" aria-label={label} hidden={options.length === 0}>
        {options.map((o) => (
          <label key={o.value} className={o.value === value ? "opt on" : "opt"}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span className="opt-head">
              <span className="opt-name">{o.value}</span>
              {o.figure}
              {o.tag && <span className="opt-tag">{o.tag}</span>}
            </span>
            {o.detail && <span className="opt-detail">{o.detail}</span>}
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

/** A path under the home directory, written from ~. */
const fromHome = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const TRACKER: Record<RepoConfig["tracker"], string> = { jira: "JIRA", github: "GitHub" };

/**
 * The confirm step, in a modal: what was detected, the repo and Pipeline to use (the Pipeline follows the repo), and
 * any notes, such as an existing branch. Confirm adds the Ticket; `onAdded` follows with it. Escape, a click outside
 * or Cancel closes it, except while the Ticket is being added.
 */
export function ConfirmIntake({ detected, onCancel, onAdded }: { detected: Detected; onCancel: () => void; onAdded: (ticket: IntakeResult) => void }) {
  const { input, detection: d } = detected;
  const [repo, setRepo] = useState(d.repo.suggestion ?? "");
  const [pipeline, setPipeline] = useState(d.pipeline.suggestion || "");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState(d.notes);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const detects = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  // What each repo and Pipeline is, to show beside its name; the choice works without it.
  const [repos, setRepos] = useState<Record<string, RepoConfig>>({});
  const [pipelines, setPipelines] = useState<Record<string, PipelineListing>>({});

  useEffect(() => {
    let live = true;
    api<ConfigFile>("/api/config").then((c) => live && setRepos(c.config.repos ?? {}), () => {});
    api<PipelineListing[]>("/api/pipelines").then((ps) => live && setPipelines(Object.fromEntries(ps.map((p) => [p.name, p]))), () => {});
    return () => void (live = false);
  }, []);

  useEffect(() => {
    const el = dialog.current!;
    if (!el.open) el.showModal();
    return () => el.close();
  }, []);

  const cancel = () => {
    if (!adding) onCancel();
  };
  // Escape: the dialog would close itself; it stays open while adding, and otherwise closes through onCancel.
  const onEscape = (ev: SyntheticEvent) => {
    ev.preventDefault();
    cancel();
  };
  // A click on the backdrop lands on the dialog itself; the form fills the rest.
  const onBackdrop = (ev: MouseEvent) => {
    if (ev.target === dialog.current) cancel();
  };

  const pickRepo = async (next: string) => {
    setRepo(next);
    // The Pipeline default follows the repo: re-pick it whenever the repo changes.
    const p = d.pipeline.byRepo[next];
    if (p) setPipeline(p);
    // A reference's branch depends on the repo: detect again for the chosen repo to refresh the notes.
    if (!d.reference) return;
    const mine = ++detects.current;
    setNotes([]);
    setError("");
    setChecking(true);
    try {
      const again = await detect(input, next);
      if (mine === detects.current) setNotes(again.notes);
    } catch (e) {
      if (mine === detects.current) setError(message(e));
    } finally {
      if (mine === detects.current) setChecking(false);
    }
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (adding || checking) return;
    if (!repo) {
      setError("repo is ambiguous: pick one");
      return;
    }
    setError("");
    setAdding(true);
    try {
      onAdded(await api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo, pipeline, name: name.trim() || null }) }));
    } catch (e) {
      setError(message(e));
      setAdding(false);
    }
  };

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="import-title" onCancel={onEscape} onClick={onBackdrop}>
      <form data-role="confirm" className="confirm" onSubmit={submit} aria-busy={adding || checking}>
        <h2 id="import-title">Import Ticket</h2>
        <div className="source">
          <div className="kind">{d.kind + (d.reference ? " " + d.reference : "")}</div>
          <p className="issue">{d.title || input}</p>
        </div>
        <label className="name-field">
          <span className="field-label">Name</span>
          <input name="name" value={name} maxLength={80} disabled={adding} placeholder={`optional; shown in place of ${d.reference ?? "the Ticket's id"}`} onChange={(ev) => setName(ev.target.value)} />
        </label>
        <Picker
          name="repo"
          label="Repo"
          value={repo}
          disabled={adding}
          onChange={(r) => void pickRepo(r)}
          empty={
            <>
              No {d.kind === "prompt" ? "" : TRACKER[d.kind] + " "}repo is set up yet.{" "}
              <a href="#config" onClick={() => onCancel()}>
                Add one in Config
              </a>
            </>
          }
          options={d.repo.choices.map((r) => {
            const c = repos[r];
            return {
              value: r,
              detail: c && (
                <>
                  <span>
                    {TRACKER[c.tracker]} {c.project}
                  </span>
                  <span className="opt-path">{fromHome(c.path)}</span>
                </>
              ),
            };
          })}
        >
          {(checking || notes.length > 0) && (
            <div className="notes">
              {checking && (
                <div className="why checking" data-role="checking">
                  checking {repo} for an existing branch
                </div>
              )}
              {notes.map((n, i) => (
                <div key={i} className="why">
                  {n}
                </div>
              ))}
            </div>
          )}
        </Picker>
        <Picker
          name="pipeline"
          label="Pipeline"
          value={pipeline}
          disabled={adding}
          onChange={setPipeline}
          options={d.pipeline.choices.map((p) => {
            const listing = pipelines[p];
            const own = repo ? d.pipeline.byRepo[repo] : null;
            return {
              value: p,
              figure: listing && <span className="opt-line" dangerouslySetInnerHTML={{ __html: pipelineLine(listing.stages) }} />,
              tag: p === own ? "repo default" : null,
              detail: listing && listing.stages.map((st) => st.label).join(", "),
            };
          })}
        />
        {error && (
          <p className="notice" data-role="confirm-error">
            {error}
          </p>
        )}
        <div className="row actions">
          <button type="button" data-role="cancel" disabled={adding} onClick={cancel}>
            Cancel
          </button>
          <button className={adding ? "primary busy" : "primary"} type="submit" disabled={adding || checking || d.repo.choices.length === 0}>
            {adding ? "Adding" : "Confirm"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
