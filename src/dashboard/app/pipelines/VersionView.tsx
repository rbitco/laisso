import { useEffect, useState, type ReactNode } from "react";
import type { PipelineVersionView, StageFields } from "../../../api/views.ts";
import { relative } from "../../metro.js";
import { api } from "../api.ts";
import { EditorHead } from "../Setting.tsx";
import { pipelineHref } from "./href.ts";
import { firstLine, RailStage, StagesHead } from "./Rail.tsx";

const Ro = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <div className={wide ? "ro wide" : "ro"}>
    {label}
    {children}
  </div>
);
const Value = ({ label, value }: { label: string; value: string }) => (
  <Ro label={label}>
    <span>{value}</span>
  </Ro>
);

const yes = (b: boolean) => (b ? "yes" : "no");
const budgetText = (b: { rounds?: number; attempts?: number; wallTime?: string }) =>
  (["rounds", "attempts", "wallTime"] as const)
    .filter((k) => b[k] !== undefined)
    .map((k) => `${k} ${b[k]}`)
    .join(", ") || "defaults";

/** One frozen Version, read-only: nothing here saves. A Ticket's Pipeline link opens it. */
export function VersionView({ name, version }: { name: string; version: number }) {
  const [v, setV] = useState<PipelineVersionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean[]>([]);
  useEffect(() => {
    api<PipelineVersionView>("/api/pipelines/" + encodeURIComponent(name) + "/versions/" + version).then(
      (read) => {
        setV(read);
        // Action Stages show their few fields open; Runner Stages start closed to one line.
        setOpen(read.pipeline.stages.map((s) => s.kind === "action"));
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [name, version]);

  if (error) return <p className="notice">{error}</p>;
  if (!v) return null;
  const pipeline = v.pipeline;
  const allOpen = open.every(Boolean);
  const stage = (s: StageFields, i: number) => {
    const toggle = () => setOpen(open.map((o, j) => (j === i ? !o : o)));
    if (s.kind === "action")
      return (
        <RailStage key={i} kind="action" station={String(i + 1)} name={s.name} summary={s.action} peek="" open={open[i]!} onToggle={toggle}>
          <div className="fields">
            <Value label="action" value={s.action} />
            {Object.entries(s.with).map(([key, value]) => (
              <Value key={key} label={key} value={value} />
            ))}
          </div>
        </RailStage>
      );
    return (
      <RailStage key={i} kind={s.human ? "human" : "runner"} station={String(i + 1)} name={s.name} summary={s.artifact ? "artifact " + s.artifact : ""} peek={firstLine(s.prompt)} open={open[i]!} onToggle={toggle}>
        <div className="fgroup">
          <h4>Settings</h4>
          <div className="fields">
            <Value label="profile" value={s.profile || (pipeline.profile ? `Pipeline's (${pipeline.profile})` : "config default")} />
            <Value label="artifact" value={s.artifact || "none"} />
            <Value label="skills" value={s.skills.join(", ") || "none"} />
            <Value label="advances on its own" value={yes(s.advance)} />
            <Value label="repeats on Feedback" value={yes(s.repeat === "feedback")} />
            <Value label="budget" value={budgetText(s.budget)} />
            <Ro label="prompt" wide>
              <pre>{s.prompt || "(none)"}</pre>
            </Ro>
          </div>
        </div>
      </RailStage>
    );
  };

  return (
    <div className="ed" data-role="pipeline-version">
      <EditorHead title={`${name} v${version}`} file={`Read-only. Frozen ${relative(v.createdAt)}, ${v.live} active Ticket${v.live === 1 ? "" : "s"}.`}>
        {v.deleted ? <span className="drift">Pipeline deleted</span> : <a href={pipelineHref(name)}>Open the current Pipeline</a>}
      </EditorHead>
      <div className="pipe-form">
        <section className="sheet pipe-settings">
          <h3>Pipeline settings</h3>
          <div className="fields">
            <Value label="Agent Profile" value={pipeline.profile || "config default"} />
            <Value label="Spend limit per Ticket (USD)" value={pipeline.budget.spend === undefined ? "global default" : String(pipeline.budget.spend)} />
          </div>
        </section>
        <StagesHead allOpen={allOpen} onExpand={() => setOpen(open.map(() => !allOpen))} />
        <div className="rail">{pipeline.stages.map(stage)}</div>
      </div>
    </div>
  );
}
