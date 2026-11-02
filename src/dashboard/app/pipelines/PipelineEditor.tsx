import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LiveVersionView, PipelineFile } from "../../../api/views.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { EditorHead } from "../Setting.tsx";
import { pipelineHref } from "./href.ts";
import { StagesForm, type LoadedPipeline } from "./StagesForm.tsx";

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
  const loaded = file.pipeline ? (file as LoadedPipeline) : null;
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
      <LiveVersions name={name} />
      {loaded ? (
        // Both stay drawn, so switching between them keeps what each holds.
        <div hidden={asText}>
          <StagesForm file={loaded} onSaved={onSaved} />
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
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const click = async () => {
    if (!armed) {
      setArmed(true);
      disarm.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(disarm.current);
    setBusy(true);
    showNotice("");
    try {
      await api(route(name), { method: "DELETE" });
      location.hash = "pipelines";
    } catch (error) {
      showNotice(message(error));
      setBusy(false);
      setArmed(false);
    }
  };
  return (
    <button type="button" className={busy ? "danger busy" : "danger"} disabled={busy} onClick={() => void click()}>
      {armed ? "Click again to delete" : "Delete"}
    </button>
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
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    showNotice("");
    try {
      await api<PipelineFile>(route(file.name), { method: "PUT", body: JSON.stringify({ text }) });
      showNotice("saved " + file.name);
      onSaved();
    } catch (error) {
      showNotice(message(error));
      setBusy(false);
    }
  };
  return (
    <form className="pipe-form" data-role="pipeline-text" onSubmit={submit}>
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
