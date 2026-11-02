import { useState, type FormEvent } from "react";
import type { PipelineFile, PipelineListing } from "../../../api/views.ts";
import { pipelineLine } from "../../metro.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { pipelineHref } from "./href.ts";

/** What a blank Pipeline starts as: one Stage that leaves commits behind. */
export const BLANK_PIPELINE = "stages:\n  - name: implement\n    prompt: Do the work.\n    artifact: commits-on-branch\n";

/** Each Pipeline as a link: its name over its Stages drawn as a line and counted, or why its file does not load. */
export function PipelineList({ list, current }: { list: PipelineListing[]; current: string | null }) {
  return (
    <div className="plist">
      {list.map((p) => (
        <a key={p.name} href={pipelineHref(p.name)} className={p.name === current ? "current" : ""} title={p.problem ? "" : p.stages.map((s) => s.label).join(" → ")}>
          <strong>{p.name}</strong>
          {p.problem ? (
            <span className="why drift">does not load</span>
          ) : (
            <>
              <span dangerouslySetInnerHTML={{ __html: pipelineLine(p.stages) }} />
              <span className="count">{p.stages.length + " Stage" + (p.stages.length === 1 ? "" : "s")}</span>
            </>
          )}
        </a>
      ))}
    </div>
  );
}

/** + New Pipeline: a name, and a blank Pipeline or a copy of one listed. Create refuses a name already in use. */
export function NewPipeline({ list }: { list: PipelineListing[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [copy, setCopy] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const named = name.trim();
    setBusy(true);
    showNotice("");
    try {
      const text = copy ? (await api<PipelineFile>("/api/pipelines/" + encodeURIComponent(copy))).text : BLANK_PIPELINE;
      await api<PipelineFile>("/api/pipelines/" + encodeURIComponent(named), { method: "PUT", body: JSON.stringify({ text, create: true }) });
      location.hash = pipelineHref(named);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid" }}>
      {open ? (
        <form data-role="new-pipeline" onSubmit={submit}>
          <div className="fields">
            <label>
              Name
              <input name="name" placeholder="new-pipeline" autoFocus value={name} onChange={(ev) => setName(ev.target.value)} />
            </label>
            <label>
              Start from
              <select name="copy" value={copy} onChange={(ev) => setCopy(ev.target.value)}>
                <option value="">A blank Pipeline</option>
                {list.map((p) => (
                  <option key={p.name} value={p.name}>
                    {"A copy of " + p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="bar" style={{ marginTop: 10 }}>
            <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy}>
              Create
            </button>
            <button type="button" className="quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="quiet" onClick={() => setOpen(true)}>
          + New Pipeline
        </button>
      )}
    </div>
  );
}
