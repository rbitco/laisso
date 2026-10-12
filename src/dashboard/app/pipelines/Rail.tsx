import type { CSSProperties, ReactNode } from "react";

export type StageKind = "runner" | "human" | "action";

const KIND_LABEL: Record<StageKind, string> = { runner: "Runner", human: "Human", action: "Action" };

/** A prompt's first line with text in it, for a closed Stage's peek. */
export const firstLine = (text: string | null): string => (text ?? "").split("\n").find((l) => l.trim()) ?? "";

export interface RailStageProps {
  kind: StageKind;
  /** What the station shows: the Stage's number. */
  station: string;
  name: string;
  /** The closed Stage's one line, after its kind. */
  summary: string;
  /** The prompt's first line, if any. */
  peek: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** One Stage drawn on the line: a station, then a head naming the Stage and its kind that opens its fields. */
export function RailStage({ kind, station, name, summary, peek, open, onToggle, children }: RailStageProps) {
  return (
    <div className={`stage k-${kind}${open ? " open" : ""}`}>
      <span className="station" aria-hidden="true">
        {station}
      </span>
      <div className="stage-box">
        <h3>
          <button type="button" className="stage-toggle" aria-expanded={open} onClick={onToggle}>
            <span className="nm">{name}</span>
            <span className="kind">{KIND_LABEL[kind]}</span>
            <span className="sum">{summary}</span>
            <span className="peek" hidden={!peek}>
              {peek}
            </span>
          </button>
        </h3>
        <div className="stage-fields" hidden={!open}>
          {children}
        </div>
      </div>
    </div>
  );
}

const Key = ({ text, colour, bar }: { text: string; colour: string; bar?: boolean }) => (
  <span>
    <i className={bar ? "bar" : ""} style={{ "--k": colour } as CSSProperties} />
    {text}
  </span>
);

/** The Stages heading, with the colour key and Expand all, which says Collapse all once every Stage is open. */
export function StagesHead({ allOpen, onExpand }: { allOpen: boolean; onExpand: () => void }) {
  return (
    <div className="stages-head">
      <h3>Stages</h3>
      <div className="legend">
        <Key text="Runner" colour="var(--run)" />
        <Key text="Human" colour="var(--amber)" />
        <Key text="Action" colour="var(--muted)" bar />
        <button type="button" className="sm quiet" onClick={onExpand}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
    </div>
  );
}
