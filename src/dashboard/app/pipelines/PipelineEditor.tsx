import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LiveVersionView, PipelineFile } from "../../../api/views.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { EditorHead } from "../Setting.tsx";
import { pipelineHref } from "./href.ts";
import { StagesForm, type LoadedPipeline } from "./StagesForm.tsx";
import { BreakConfirm, confirmQuery, wouldBreak, type Breaking } from "./BreakConfirm.tsx";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const route = (name: string) => "/api/pipelines/" + encodeURIComponent(name);

/**
 * One Pipeline's editor: its head with Edit as text and Delete, the Versions active Tickets still run, and either the
 * Stage editor or the whole file as text. A file that does not load opens as text with its problem shown, and stays
 * there. `onSaved` follows a save from either.
 */
export function PipelineEditor({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [file, setFile] = useState<PipelineFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  useEffect(() => {
    api<PipelineFile>(route(name)).then(setFile, (e: unknown) => setError(message(e)));
  }, [name]);

  if (error) return <p className="notice">{error}</p>;
  if (!file) return null;
  // A Pipeline that reuses Stages opens as text until the Stage editor can write reuse entries (LASSO-222).
  const loaded = file.pipeline && !file.reuses ? (file as LoadedPipeline) : null;
  return (
    <div className="ed" data-role="pipeline-editor">
      <EditorHead title={file.name} file={file.file}>
        {loaded && (
          <button type="button" className="quiet" onClick={() => setAsText(!asText)}>
            {asText ? "Edit as fields" : "Edit as text"}
          </button>
        )}
        <DeleteButton name={name} />
      </EditorHead>
      {file.parts && (
        <div className="info-strip" data-role="parts">
          <h3>Kept as parts</h3>
          <div className="why">intake: false, so Intake never offers this Pipeline. Other Pipelines reuse its Stages with use: or include:.</div>
        </div>
      )}
      <ReusedBy file={file} />
      <LiveVersions name={name} />
      {loaded ? (
        // Both stay drawn, so switching between them keeps what each holds.
        <div hidden={asText}>
          <StagesForm file={loaded} onSaved={onSaved} />
        </div>
      ) : file.pipeline ? (
        <div className="card" data-role="reuse-text-only">
          <div className="why">This Pipeline reuses Stages from other Pipelines, so it opens as text for now.</div>
        </div>
      ) : (
        <div className="card problem">
          <div className="why">{`This file does not load: ${file.problem}. Fix it as text.`}</div>
        </div>
      )}
      <div hidden={!!loaded && !asText}>
        <TextEditor file={file} onSaved={onSaved} />
      </div>
    </div>
  );
}

/** Delete asks for a second click within four seconds, then removes the file; Tickets under way keep their Version. */
function DeleteButton({ name }: { name: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [breaking, setBreaking] = useState<Breaking | null>(null);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const remove = async (confirm: boolean) => {
    setBreaking(null);
    setBusy(true);
    showNotice("");
    try {
      await api(route(name) + confirmQuery(confirm), { method: "DELETE" });
      location.hash = "pipelines";
    } catch (error) {
      // Deleting a Pipeline others reuse asks first (LASSO-219).
      const breaks = confirm ? null : wouldBreak(error);
      if (breaks) setBreaking({ message: breaks, go: () => void remove(true) });
      else showNotice(message(error));
      setBusy(false);
      setArmed(false);
    }
  };
  const click = async () => {
    if (!armed) {
      setArmed(true);
      disarm.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(disarm.current);
    await remove(false);
  };
  return (
    <>
      <button type="button" className={busy ? "danger busy" : "danger"} disabled={busy} onClick={() => void click()}>
        {armed ? "Click again to delete" : "Delete"}
      </button>
      {breaking && <BreakConfirm breaking={breaking} action="Delete anyway" onCancel={() => setBreaking(null)} />}
    </>
  );
}

/** The Pipelines that take Stages from this one (LASSO-220): a save here changes them too. Nothing when none does. */
function ReusedBy({ file }: { file: PipelineFile }) {
  if (!file.reusedBy?.length) return null;
  return (
    <div className="info-strip" data-role="reused-by">
      <h3>Reused by</h3>
      {file.reusedBy.map((r) => (
        <a key={r.pipeline} href={pipelineHref(r.pipeline)} title={"takes " + r.stages.join(", ")}>
          {r.pipeline}
        </a>
      ))}
      <div className="why">Saving here changes these Pipelines too. A save that would stop one loading asks first.</div>
    </div>
  );
}

/** The Versions of this Pipeline that active Tickets still run; they keep running them whatever is saved here. */
function LiveVersions({ name }: { name: string }) {
  const [versions, setVersions] = useState<LiveVersionView[]>([]);
  useEffect(() => {
    // The editor still works without it.
    api<LiveVersionView[]>(route(name) + "/versions").then(setVersions, () => undefined);
  }, [name]);
  if (!versions.length) return null;
  return (
    <div className="info-strip" data-role="live-versions">
      <h3>Versions in use</h3>
      {versions.map((v) => (
        <a key={v.version} href={pipelineHref(name, v.version)}>{`v${v.version} (${v.live} Ticket${v.live === 1 ? "" : "s"})`}</a>
      ))}
      <div className="why">Tickets under way keep the Version they started with. Saving here changes new Tickets only.</div>
    </div>
  );
}

/** The whole file as text, comments included; the server refuses it unless it parses, and the text stays for fixing. */
function TextEditor({ file, onSaved }: { file: PipelineFile; onSaved: () => void }) {
  const [text, setText] = useState(file.text);
  const [busy, setBusy] = useState(false);
  const [breaking, setBreaking] = useState<Breaking | null>(null);
  const send = async (confirm: boolean) => {
    setBreaking(null);
    setBusy(true);
    showNotice("");
    try {
      await api<PipelineFile>(route(file.name) + confirmQuery(confirm), { method: "PUT", body: JSON.stringify({ text }) });
      showNotice("saved " + file.name);
      onSaved();
    } catch (error) {
      // A save that would stop other Pipelines loading asks first (LASSO-219).
      const breaks = confirm ? null : wouldBreak(error);
      if (breaks) setBreaking({ message: breaks, go: () => void send(true) });
      else showNotice(message(error));
      setBusy(false);
    }
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    await send(false);
  };
  return (
    <form className="pipe-form" data-role="pipeline-text" onSubmit={submit}>
      {breaking && <BreakConfirm breaking={breaking} action="Save anyway" onCancel={() => setBreaking(null)} />}
      <textarea className="raw" name="text" spellCheck={false} aria-label={`${file.name} as text`} value={text} onChange={(ev) => setText(ev.target.value)} />
      <div className="savebar">
        <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy}>
          Save text
        </button>
        <span className="why">Saves the whole file, comments included. Refused unless it parses.</span>
      </div>
    </form>
  );
}
