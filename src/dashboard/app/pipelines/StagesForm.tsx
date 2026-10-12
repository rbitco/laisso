import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Config } from "../../../server/config.ts";
import type { ActionListing, ConfigFile, PipelineFile, PipelineView } from "../../../api/views.ts";
import { stageProfileView } from "../../metro.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { openProfileDrawer } from "../profiles/drawer.tsx";
import { ProfileButton } from "../profiles/ProfileButton.tsx";
import { firstLine, RailStage, StagesHead } from "./Rail.tsx";
import { actionKeys, addStage, FieldError, moveStage, paramsOf, pipelinePatch, removeStage, stageTitle, type ActionDraft, type Card, type Params, type PipelineDraft, type RunnerDraft, draftOf } from "./stages.ts";

/** A Pipeline file that loads, as the Stage editor takes it. */
export type LoadedPipeline = PipelineFile & { pipeline: PipelineView };

/** What the editor reads from config: the profiles a Stage resolves against, and the budget defaults its blanks fall back to. */
type StageConfig = Pick<Config, "profiles" | "default_profile"> & { budget: Partial<Config["budget"]> };

// Without config the editor still works; it just has no profiles or defaults to show.
const NO_CONFIG: StageConfig = { profiles: {}, default_profile: null, budget: {} };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The structured editor for a Pipeline's settings and Stages, saved with its own Save changes; `onSaved` follows a
 * save. It reads config's Actions and profiles afresh for each file.
 */
export function StagesForm({ file, onSaved }: { file: LoadedPipeline; onSaved: () => void }) {
  const [loaded, setLoaded] = useState<{ params: Params; config: StageConfig } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<ActionListing[]>("/api/actions").catch((): ActionListing[] => []),
      api<ConfigFile>("/api/config").then((c): StageConfig => c.config, () => NO_CONFIG),
    ]).then(([actions, config]) => {
      if (live) setLoaded({ params: paramsOf(actions), config });
    });
    return () => void (live = false);
  }, [file]);
  if (!loaded) return null;
  return <Editor file={file} params={loaded.params} start={loaded.config} onSaved={onSaved} />;
}

const Field = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <label className={wide ? "wide" : ""}>
    {label}
    {children}
  </label>
);

const Check = ({ label, name, on, onChange }: { label: string; name: string; on: boolean; onChange: (on: boolean) => void }) => (
  <label className="check wide">
    <input type="checkbox" name={name} checked={on} onChange={(ev) => onChange(ev.target.checked)} />
    {label}
  </label>
);

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="fgroup">
    <h4>{title}</h4>
    <div className="fields">{children}</div>
  </div>
);

/** Where to put the cursor once drawn: a field of the card `id`, or of the Pipeline settings when null. */
type Focus = { id: number | null; selector: string };

/**
 * The editor proper. Additions, moves and removals wait for Save, and undo brings a Stage back as it was. Any edit
 * marks it unsaved; opening and closing cards does not.
 */
function Editor({ file, params, start, onSaved }: { file: LoadedPipeline; params: Params; start: StageConfig; onSaved: () => void }) {
  const pipeline = file.pipeline;
  // A profile drawer save brings the new config, so each button resolves against what config.yaml now says.
  const [config, setConfig] = useState(start);
  const [draft, setDraft] = useState(() => draftOf(pipeline));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!focus) return;
    const at = draft.cards.findIndex((c) => c.id === focus.id);
    const scope = focus.id === null ? form.current : form.current?.querySelectorAll(".rail > .stage")[at];
    scope?.querySelector<HTMLElement>(focus.selector)?.focus();
    setFocus(null);
  }, [focus, draft.cards]);

  const edit = (change: (d: PipelineDraft) => PipelineDraft) => {
    setDraft(change);
    setDirty(true);
  };
  const editCards = (change: (cards: Card[]) => Card[]) => edit((d) => ({ ...d, cards: change(d.cards) }));
  const editStage = (id: number, change: Partial<RunnerDraft> | Partial<ActionDraft>) =>
    editCards((cards) => cards.map((c) => (c.id === id ? ({ ...c, draft: { ...c.draft, ...change } } as Card) : c)));
  const setOpen = (open: (c: Card) => boolean) => setDraft((d) => ({ ...d, cards: d.cards.map((c) => ({ ...c, open: open(c) })) }));
  const allOpen = draft.cards.every((c) => c.open);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    showNotice("");
    let patch;
    try {
      patch = pipelinePatch(pipeline, draft, params);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      showNotice(error.message);
      const card = error.stage === null ? null : draft.cards[error.stage]!.id;
      if (card !== null) setOpen((c) => c.open || c.id === card);
      setFocus({ id: card, selector: `[name="${error.field}"]` });
      return;
    }
    if (!Object.keys(patch).length) {
      showNotice("nothing changed");
      return;
    }
    setBusy(true);
    try {
      await api<PipelineFile>("/api/pipelines/" + encodeURIComponent(file.name), { method: "PATCH", body: JSON.stringify(patch) });
      showNotice("saved " + file.name);
      onSaved();
    } catch (error) {
      showNotice(message(error));
      setBusy(false);
    }
  };

  const names = Object.keys(config.profiles).sort();
  // A profile config lacks stays pickable, so the dropdown shows what the file names.
  const choices = draft.profile && !names.includes(draft.profile) ? [draft.profile, ...names] : names;
  const spendDefault = config.budget.spend;
  const kept = draft.cards.filter((c) => !c.removed).length;
  let station = 0;

  return (
    <form ref={form} className={dirty ? "pipe-form dirty" : "pipe-form"} data-role="pipeline-fields" onSubmit={submit}>
      <section className="sheet pipe-settings">
        <h3>Pipeline settings</h3>
        <p className="about">Defaults for every Stage below. A Stage can pick its own Agent Profile.</p>
        <div className="fields">
          <Field label="Agent Profile">
            <select name="profile" data-role="pipeline-profile" value={draft.profile} onChange={(ev) => edit((d) => ({ ...d, profile: ev.target.value }))}>
              <option value="">{`config default (${config.default_profile || "none"})`}</option>
              {choices.map((r) => (
                <option key={r} value={r}>
                  {names.includes(r) ? r : r + " (not in config.yaml)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Spend limit per Ticket (USD)">
            <input name="spend" value={draft.spend} placeholder={spendDefault === undefined ? "global default" : `global default (${spendDefault})`} onChange={(ev) => edit((d) => ({ ...d, spend: ev.target.value }))} />
          </Field>
        </div>
      </section>
      <StagesHead allOpen={allOpen} onExpand={() => setOpen(() => !allOpen)} />
      <div className="rail" data-role="stage-list">
        {draft.cards.map((card, i) => {
          const label = card.stage.name || "the new Stage";
          const tools = (
            <>
              <span className="removed-note">removed on Save</span>
              <span className="tools">
                <button type="button" className="sm" data-role="move-up" title="run this Stage earlier" aria-label={`move ${label} up`} style={i === 0 ? { visibility: "hidden" } : undefined} onClick={() => editCards((cards) => moveStage(cards, card.id, -1))}>
                  ↑
                </button>
                <button type="button" className="sm" data-role="move-down" title="run this Stage later" aria-label={`move ${label} down`} style={i === draft.cards.length - 1 ? { visibility: "hidden" } : undefined} onClick={() => editCards((cards) => moveStage(cards, card.id, 1))}>
                  ↓
                </button>
                <button
                  type="button"
                  className="sm"
                  data-role="remove-stage"
                  aria-label={card.removed ? undefined : `remove ${label}`}
                  title={card.removed ? "keep this Stage" : kept === 1 ? "a Pipeline keeps at least one Stage" : card.fresh ? "drop this new Stage" : "remove this Stage on Save"}
                  disabled={!card.removed && kept === 1}
                  onClick={() => editCards((cards) => removeStage(cards, card.id))}
                >
                  {card.removed ? "Undo" : "✕"}
                </button>
              </span>
            </>
          );
          const shared = {
            card,
            station: card.removed ? "" : String(++station),
            tools,
            onToggle: () => setOpen((c) => (c.id === card.id ? !c.open : c.open)),
          };
          return (
            <Fragment key={card.id}>
              {card.draft.kind === "action" ? (
                <ActionCard {...shared} draft={card.draft} params={params} onEdit={(change) => editStage(card.id, change)} />
              ) : (
                <RunnerCard {...shared} draft={card.draft} pipeline={file.name} pipelineProfile={draft.profile || null} config={config} onConfig={setConfig} onEdit={(change) => editStage(card.id, change)} />
              )}
              <AddStage
                after={label}
                onAdd={(kind) => {
                  const next = addStage(draft.cards, card.id, kind);
                  edit((d) => ({ ...d, cards: next }));
                  setFocus({ id: next[i + 1]!.id, selector: ".stage-fields input, .stage-fields select" });
                }}
              />
            </Fragment>
          );
        })}
      </div>
      <div className="savebar">
        <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy}>
          Save changes
        </button>
        <span className="state">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <span className="why">Blank fields fall back to their defaults. Added, moved and removed Stages apply on Save.</span>
      </div>
    </form>
  );
}

/** "+" after each Stage asks which kind first, then adds a blank one there. */
function AddStage({ after, onAdd }: { after: string; onAdd: (kind: "runner" | "action") => void }) {
  const [choosing, setChoosing] = useState(false);
  const add = (kind: "runner" | "action") => {
    setChoosing(false);
    onAdd(kind);
  };
  return (
    <div className="add-stage">
      {choosing ? (
        <>
          <button type="button" className="sm add-k" data-role="add-runner" onClick={() => add("runner")}>
            + Runner Stage
          </button>
          <button type="button" className="sm add-k" data-role="add-action" onClick={() => add("action")}>
            + Action Stage
          </button>
          <button type="button" className="sm quiet" data-role="add-cancel" title="add nothing" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" data-role="add-stage" title="add a Stage here" aria-label={`add a Stage after ${after}`} onClick={() => setChoosing(true)}>
          +
        </button>
      )}
    </div>
  );
}

interface CardProps {
  card: Card;
  station: string;
  tools: ReactNode;
  onToggle: () => void;
}

const stageClass = (card: Card) => [card.fresh && "fresh", card.removed && "removed"].filter(Boolean).join(" ");

/** An Action Stage: the Action picked from config, and one field per param it takes. */
function ActionCard({ card, station, tools, onToggle, draft, params, onEdit }: CardProps & { draft: ActionDraft; params: Params; onEdit: (change: Partial<ActionDraft>) => void }) {
  const s = card.stage;
  if (s.kind !== "action") throw new Error("an Action card needs an Action Stage");
  // A Stage naming an Action config lacks keeps it pickable, and its own params.
  const names = Object.keys(params).sort();
  if (s.action && !names.includes(s.action)) names.unshift(s.action);
  const keys = actionKeys(s, draft.action, params);
  const summary = [draft.action || "no Action picked", ...keys.map((key) => key + ": " + ((draft.with[key] ?? "").trim() || "(blank)"))].join(", ");
  return (
    <RailStage kind="action" station={station} name={stageTitle(card)} summary={summary} peek="" open={card.open} onToggle={onToggle} className={stageClass(card)} role="action-stage" tools={tools}>
      <div className="fields">
        <Field label="Action">
          <select name="action" value={draft.action} onChange={(ev) => onEdit({ action: ev.target.value })}>
            {!s.action && <option value="">pick one</option>}
            {names.map((name) => (
              <option key={name} value={name}>
                {name === s.action && !params[name] ? name + " (not in config.yaml)" : name}
              </option>
            ))}
          </select>
        </Field>
        {keys.map((key) => (
          <Field key={key} label={key}>
            <input name={key} value={draft.with[key] ?? ""} placeholder="required" onChange={(ev) => onEdit({ with: { ...draft.with, [key]: ev.target.value } })} />
          </Field>
        ))}
        {!names.length && <div className="why">config.yaml defines no Actions yet; add one under actions: to run it here</div>}
      </div>
    </RailStage>
  );
}

interface RunnerCardProps extends CardProps {
  draft: RunnerDraft;
  pipeline: string;
  /** The Pipeline dropdown's choice, which a Stage naming no profile inherits. */
  pipelineProfile: string | null;
  config: StageConfig;
  onConfig: (config: Config) => void;
  onEdit: (change: Partial<RunnerDraft>) => void;
}

/** A Runner or Human Stage: its task, how it runs, when it is done, and its limits. */
function RunnerCard({ card, station, tools, onToggle, draft, pipeline, pipelineProfile, config, onConfig, onEdit }: RunnerCardProps) {
  const byDefault = (v: number | string | undefined) => (v === undefined ? "default" : `default (${v})`);
  // The closed card's line: who runs it, what it leaves behind, and anything unusual about how it moves on.
  const v = stageProfileView(draft.profile, pipelineProfile, config);
  const bits = [v.name || "no profile", draft.artifact.trim() ? "leaves " + draft.artifact.trim() : "no artifact"];
  if (draft.repeat) bits.push("repeats on Feedback");
  if (!draft.advance) bits.push("waits for Start");
  const text = (name: "name" | "skills" | "artifact" | "rounds" | "attempts" | "wallTime", placeholder: string) => (
    <input name={name} value={draft[name]} placeholder={placeholder} onChange={(ev) => onEdit({ [name]: ev.target.value })} />
  );
  return (
    <RailStage kind={draft.human ? "human" : "runner"} station={station} name={stageTitle(card)} summary={bits.join(", ")} peek={firstLine(draft.prompt)} open={card.open} onToggle={onToggle} className={stageClass(card)} tools={tools}>
      <Group title="Task">
        <Field label="Name">{text("name", "implement")}</Field>
        <Field label="Skills">{text("skills", "grilling, to-spec")}</Field>
        <Field label="Prompt" wide>
          <textarea name="prompt" placeholder="What the agent should do in this Stage" value={draft.prompt} onChange={(ev) => onEdit({ prompt: ev.target.value })} />
        </Field>
      </Group>
      <Group title="Runs as">
        <Field label="Agent Profile" wide>
          <StageProfileButton card={card} draft={draft} pipeline={pipeline} pipelineProfile={pipelineProfile} config={config} onConfig={onConfig} onPick={(profile) => onEdit({ profile })} />
        </Field>
        <Check label="Human Stage: opens a terminal for you to work in" name="human" on={draft.human} onChange={(human) => onEdit({ human })} />
      </Group>
      <Group title="Done when">
        <Field label="Artifact" wide>
          {text("artifact", "commits-on-branch, file NOTES.md")}
        </Field>
        <Check label="Move to the next Stage on its own" name="advance" on={draft.advance} onChange={(advance) => onEdit({ advance })} />
        <Check label="Repeat on Feedback until the artifact is met" name="repeat" on={draft.repeat} onChange={(repeat) => onEdit({ repeat })} />
      </Group>
      <Group title="Limits">
        <Field label="Feedback rounds">{text("rounds", byDefault(config.budget.rounds))}</Field>
        <Field label="Attempts">{text("attempts", byDefault(config.budget.attempts))}</Field>
        <Field label="Time per Session">{text("wallTime", byDefault(config.budget.wallTime))}</Field>
      </Group>
    </RailStage>
  );
}

/**
 * A Runner Stage's profile: a button naming what it runs ("inherit → <profile>" when it names none) over each
 * mode's resolved line. It opens the profile drawer, which edits profiles at once; "Use <profile> for <stage>" and
 * "Inherit instead" only change this card, and the Pipeline's Save writes them, like every other field here.
 * The Pipeline editor has no repo, so what it shows resolves against the global profiles and default_profile.
 */
function StageProfileButton({ card, draft, pipeline, pipelineProfile, config, onConfig, onPick }: { card: Card; draft: RunnerDraft; pipeline: string; pipelineProfile: string | null; config: StageConfig; onConfig: (config: Config) => void; onPick: (profile: string | null) => void }) {
  const v = stageProfileView(draft.profile, pipelineProfile, config);
  const saved = card.stage.kind === "runner" ? card.stage.profile : null;
  const open = () => {
    const stage = draft.name.trim() || "the new Stage";
    // The drawer asks before dropping unsaved profile edits, and closes once a choice is made.
    openProfileDrawer(v.name, {
      context: `Stage ${stage} of Pipeline ${pipeline}`,
      extra: (name) => ({
        role: "stage-profile-choice",
        why: "sets this Stage in the editor; the Pipeline's Save writes it",
        choices: [
          { role: "profile-use", primary: true, label: `Use ${name} for ${stage}`, act: () => onPick(name) },
          { role: "profile-inherit", label: "Inherit instead", act: () => onPick(null) },
        ],
      }),
      onChange: onConfig,
    });
  };
  return (
    <ProfileButton
      label={v.label + "  ✎" + (draft.profile !== saved ? "  (unsaved)" : "")}
      headless={v.headless}
      human={v.human}
      role="stage-profile"
      title="resolved from config.yaml's global profiles; a repo's own default_profile or override may differ"
      onClick={open}
    />
  );
}
