import type { ReactNode } from "react";
import type { RunnerName } from "../../../pipeline/load.ts";
import { MODEL_SUGGESTIONS, profileApplies, profileMode } from "../../metro.ts";
import { profileOf, type BlockDraft, type Draft, type Mode } from "./profile.ts";

const RUNNERS: RunnerName[] = ["claude", "codex", "pi"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSIONS = ["auto", "edits", "full"];

function Choice({ name, choices, value, blank, onChange }: { name: string; choices: string[]; value: string; blank?: string; onChange: (value: string) => void }) {
  return (
    <select name={name} value={value} onChange={(ev) => onChange(ev.target.value)}>
      {blank !== undefined && <option value="">{blank}</option>}
      {choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

/** A field that does nothing on this Runner, shown greyed with why. */
function NotApplicable({ label, role, why }: { label: string; role: string; why: string }) {
  return (
    <label className="pf-na" data-role={role}>
      {label}
      <span>{why}</span>
    </label>
  );
}

/**
 * The drawer's fields for one profile: the Runner, the shared model, effort, permission and args, skills_dir, then a
 * block per mode whose blanks inherit the shared ones. A field the Runner ignores is shown as n/a.
 */
export function ProfileFields({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const listId = `pf-models-${draft.runner}`;
  const shared = profileOf({ ...draft, headless: blank(), human: blank() });

  // One set of model, effort, permission and args: the shared ones, or a mode block whose blanks inherit them.
  const blockFields = (b: BlockDraft, mode: Mode | null, write: (b: BlockDraft) => void): ReactNode[] => {
    const set = (key: keyof BlockDraft) => (value: string) => write({ ...b, [key]: value });
    const resolved = mode ? profileMode(shared, mode) : null;
    const inherit = (v: string) => `inherits ${v}`;
    return [
      <label key="model">
        model
        <input name="model" value={b.model} list={listId} placeholder={mode ? inherit(draft.model.trim() || "default") : "Runner default"} onChange={(ev) => set("model")(ev.target.value)} />
      </label>,
      <label key="effort">
        effort
        <Choice name="effort" choices={EFFORTS} value={b.effort} blank={mode ? inherit(draft.effort || "default") : "Runner default"} onChange={set("effort")} />
      </label>,
      profileApplies(draft.runner, "permission") ? (
        <label key="permission">
          permission
          <Choice name="permission" choices={PERMISSIONS} value={b.permission} blank={resolved ? inherit(resolved.permission + (resolved.baseline ? " (default)" : "")) : "default per mode"} onChange={set("permission")} />
        </label>
      ) : (
        <NotApplicable key="permission" label="permission" role="permission-na" why="n/a on Pi" />
      ),
      <label key="args">
        args
        <input name="args" value={b.args} placeholder={mode ? "added after the shared args" : "--flag value"} onChange={(ev) => set("args")(ev.target.value)} />
      </label>,
    ];
  };

  return (
    <div data-role="profile-fields" style={{ display: "grid", gap: 12 }}>
      <datalist id={listId}>
        {(MODEL_SUGGESTIONS[draft.runner] ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="fields">
        <label>
          runner
          <Choice name="runner" choices={RUNNERS} value={draft.runner} onChange={(runner) => onChange({ ...draft, runner: runner as RunnerName })} />
        </label>
        {blockFields(draft, null, (b) => onChange({ ...draft, ...b }))}
        {profileApplies(draft.runner, "skills_dir") ? (
          <label>
            skills_dir
            <input name="skills_dir" value={draft.skills_dir} placeholder="~/.agents/skills" onChange={(ev) => onChange({ ...draft, skills_dir: ev.target.value })} />
          </label>
        ) : (
          <NotApplicable label="skills_dir" role="skills-dir-na" why="n/a: Codex only" />
        )}
      </div>
      <div className="pf-modes">
        {(
          [
            ["headless", "mode-headless", "headless only"],
            ["human", "mode-human", "human only"],
          ] as const
        ).map(([mode, role, title]) => (
          <div key={mode} data-role={role}>
            <div className="eyebrow">{title}</div>
            <div className="fields">{blockFields(draft[mode], mode, (b) => onChange({ ...draft, [mode]: b }))}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function blank(): BlockDraft {
  return { model: "", effort: "", permission: "", args: "" };
}
