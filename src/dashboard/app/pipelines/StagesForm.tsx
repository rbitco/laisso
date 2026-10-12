import { useEffect, useRef } from "react";
import type { PipelineFile, PipelineView } from "../../../api/views.ts";

/** A Pipeline file that loads, as the Stage editor takes it. */
export type LoadedPipeline = PipelineFile & { pipeline: PipelineView };

/** The old script's Stage editor for one Pipeline: built once per file read; `saved` follows a Save that went through. */
export type OldStagesForm = (file: LoadedPipeline, saved: () => void) => Promise<HTMLElement>;

let build: OldStagesForm | null = null;

/**
 * The old script hands over its Stage editor once, at startup. Until LASSO-80 moves the editor to React, StagesForm
 * mounts what this builds; then this, and the old script's call to it, go.
 */
export function adoptOldStagesForm(form: OldStagesForm): void {
  build = form;
}

/**
 * The structured editor for a Pipeline's settings and Stages, saved with its own Save changes; `onSaved` follows a
 * save. For now it mounts the old script's form into a box of its own, which React leaves alone after drawing it.
 */
export function StagesForm({ file, onSaved }: { file: LoadedPipeline; onSaved: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    const into = box.current!;
    let mounted = true;
    void build?.(file, () => saved.current()).then((form) => {
      if (mounted) into.replaceChildren(form);
    });
    return () => {
      mounted = false;
      into.replaceChildren();
    };
  }, [file]);
  return <div ref={box} />;
}
