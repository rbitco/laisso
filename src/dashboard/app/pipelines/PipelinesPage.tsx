import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineListing } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { PipelineList, NewPipeline } from "./PipelineList.tsx";
import { PipelineEditor } from "./PipelineEditor.tsx";
import { VersionView } from "./VersionView.tsx";

export interface PipelinesPageProps {
  /** The Pipeline open on the right, if any. */
  name: string | null;
  /** The frozen Version of it shown read-only, or null for its editor. */
  version: number | null;
  /** Bumped each time the page is shown, so it reads everything afresh. */
  visit: number;
}

/**
 * Pipelines: the list on the left, each with its Stages drawn as a line, and + New Pipeline under it; on the right,
 * one Pipeline's editor or one of its Versions. The list is read again whenever the server says a Pipeline changed.
 */
export function PipelinesPage({ name, version, visit }: PipelinesPageProps) {
  const [list, setList] = useState<PipelineListing[] | null>(null);
  // Bumped by a save, so the editor reads the file it wrote.
  const [saves, setSaves] = useState(0);
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const listed = await api<PipelineListing[]>("/api/pipelines");
      // A slower, older read must not replace a newer one.
      if (mine === reads.current) setList(listed);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => void read(), [read, visit]);
  useEvents(["pipeline"], () => void read());

  if (!list) return null;
  const saved = () => {
    setSaves((n) => n + 1);
    void read();
  };
  const body = !name ? (
    <p className="empty">{list.length ? "Pick a Pipeline to edit it, or make a new one." : "No Pipelines yet. Make one to get started."}</p>
  ) : version ? (
    <VersionView key={`${name}/v${version}/${visit}`} name={name} version={version} />
  ) : (
    <PipelineEditor key={`${name}/${visit}/${saves}`} name={name} onSaved={saved} />
  );
  return (
    <div className="pipelines-grid">
      <div className="plist-wrap">
        <PipelineList list={list} current={name} />
        <NewPipeline key={visit} list={list} />
      </div>
      {body}
    </div>
  );
}
