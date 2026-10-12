import { useRef, useState, type FormEvent } from "react";
import type { IntakeResult } from "../../../api/views.ts";
import type { Detection } from "../../../intake/detect.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { message } from "../ticket/ticket.ts";

/** What was pasted and what Lasso detected in it, waiting on the person to confirm. */
export interface Detected {
  input: string;
  detection: Detection;
}

const detect = (input: string, repo?: string) => api<Detection>("/api/intake/detect", { method: "POST", body: JSON.stringify({ input, repo }) });

/** The header's one input: paste a JIRA key or a GitHub issue, or type a prompt; Lasso says what it found before adding. */
export function IntakeForm({ text, onText, onDetected }: { text: string; onText: (text: string) => void; onDetected: (detected: Detected) => void }) {
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const input = text.trim();
    if (!input) return;
    showNotice("");
    try {
      onDetected({ input, detection: await detect(input) });
    } catch (error) {
      showNotice(message(error));
    }
  };
  return (
    <form data-role="intake" autoComplete="off" onSubmit={submit}>
      <input name="input" placeholder="Paste a JIRA key, a GitHub issue, or type a prompt" aria-label="Intake" value={text} onChange={(ev) => onText(ev.target.value)} />
      <button className="primary" type="submit">
        Add
      </button>
    </form>
  );
}

/** A picker preset to Lasso's suggestion; with none, it starts on "pick one". */
function Choice({ name, choices, suggestion, value, onChange }: { name: string; choices: string[]; suggestion: string | null; value: string; onChange: (value: string) => void }) {
  return (
    <select name={name} aria-label={name} value={value} onChange={(ev) => onChange(ev.target.value)}>
      {!suggestion && <option value="">pick one</option>}
      {choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

/**
 * The confirm step: what was detected, the repo and Pipeline to use (the Pipeline follows the repo), and any notes,
 * such as an existing branch. Confirm adds the Ticket; `onAdded` follows with it.
 */
export function ConfirmIntake({ detected, onCancel, onAdded }: { detected: Detected; onCancel: () => void; onAdded: (ticket: IntakeResult) => void }) {
  const { input, detection: d } = detected;
  const [repo, setRepo] = useState(d.repo.suggestion ?? "");
  const [pipeline, setPipeline] = useState(d.pipeline.suggestion || "");
  const [notes, setNotes] = useState(d.notes);
  const detects = useRef(0);

  const pickRepo = async (next: string) => {
    setRepo(next);
    // The Pipeline default follows the repo: re-pick it whenever the repo changes.
    const p = d.pipeline.byRepo[next];
    if (p) setPipeline(p);
    // A reference's branch depends on the repo: detect again for the chosen repo to refresh the notes.
    if (!d.reference) return;
    const mine = ++detects.current;
    setNotes([]);
    try {
      const again = await detect(input, next);
      if (mine === detects.current) setNotes(again.notes);
    } catch (error) {
      showNotice(message(error));
    }
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!repo) {
      showNotice("repo is ambiguous: pick one");
      return;
    }
    try {
      onAdded(await api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input, repo, pipeline }) }));
    } catch (error) {
      showNotice(message(error));
    }
  };

  return (
    <form data-role="confirm" className="confirm" onSubmit={submit}>
      <div className="kind">{d.kind + (d.reference ? " " + d.reference : "")}</div>
      <div>{d.title || input}</div>
      <div className="row">
        <label>repo</label>
        <Choice name="repo" choices={d.repo.choices} suggestion={d.repo.suggestion} value={repo} onChange={(r) => void pickRepo(r)} />
        <label>pipeline</label>
        <Choice name="pipeline" choices={d.pipeline.choices} suggestion={d.pipeline.suggestion} value={pipeline} onChange={setPipeline} />
      </div>
      <div className="notes">
        {notes.map((n, i) => (
          <div key={i} className="why">
            {n}
          </div>
        ))}
      </div>
      <div className="row">
        <button className="primary" type="submit">
          Confirm
        </button>
        <button type="button" data-role="cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
