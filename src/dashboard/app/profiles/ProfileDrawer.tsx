import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../../../server/config.ts";
import type { ConfigFile, PipelineListing } from "../../../api/views.ts";
import { api, ApiError } from "../api.ts";
import { useEvents } from "../events.ts";
import { overridableRepos, profileIndex, profileLine, profileRoute, profileScopes, profileUsers, profileWarnings, scopedProfile, scopeNote, usedByLine } from "../../metro.js";
import { draftOf, profileOf, unsaved, type Draft } from "./profile.ts";
import { ProfileFields } from "./ProfileFields.tsx";

/** One button placed under the editor by whoever opened the drawer, such as "Use <profile> for <stage>". */
export interface DrawerChoice {
  label: string;
  role: string;
  primary?: boolean;
  hidden?: boolean;
  /** Runs on a press; the drawer closes once it succeeds, and shows a refusal in itself. */
  act: () => unknown;
}

/** A row of choices with an optional note after them. */
export interface DrawerExtra {
  role: string;
  choices: DrawerChoice[];
  why?: string;
}

export interface DrawerOptions {
  /** The repo whose tab to start on; without it (as from a Stage) the global tab, or for a profile only repos define, the first of them. */
  scope?: string | null;
  /** A line under the title saying where the drawer was opened from (a Stage, a Ticket). */
  context?: string;
  /** Choices placed under the editor for the open profile and tab. */
  extra?: (name: string, config: Config, scope: string | null) => DrawerExtra | null;
  /** Called with the new config after each save, default change or delete. */
  onChange?: (config: Config) => void;
}

interface Open {
  name: string | null;
  scope: string | null;
  draft: Draft | null;
}

/**
 * One profile on one scope's tab. A name config lacks falls back to default_profile, then the first profile; a
 * scope the profile lacks falls back to its global tab, then its first repo's.
 */
function pick(config: Config, name: string | null, scope: string | null): Open {
  const index = profileIndex(config);
  const entry = index.find((e) => e.name === name) ?? index.find((e) => e.global && e.name === config.default_profile) ?? index[0] ?? null;
  if (!entry) return { name: null, scope: null, draft: null };
  const scopes = profileScopes(entry);
  const at = scopes.some((s) => s.repo === scope) ? scope : (scopes[0]?.repo ?? null);
  const saved = scopedProfile(config, entry.name, at);
  return { name: entry.name, scope: at, draft: saved ? draftOf(saved) : null };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The profile drawer: every profile on the left with + New (repo-only ones marked), one profile's editor on the
 * right under scope tabs: "global", then each repo with its own definition, and "Override for repo…", which copies
 * the global profile into a repo's profiles:. Each tab edits that scope's definition; removing a repo's override
 * returns that repo to the global one. Every action writes config.yaml at once. Leaving a profile with unsaved
 * edits, by another profile, another tab, Close or Escape, asks first.
 */
export function ProfileDrawer({ start, options = {}, onClose, onDirty }: { start: string | null; options?: DrawerOptions; onClose: () => void; onDirty?: (name: string | null) => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>({ name: null, scope: null, draft: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Delete asks twice; refused while in use, it says what names the profile and the next press deletes anyway.
  const [armed, setArmed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const { name, scope, draft } = open;
  const saved = config && name ? scopedProfile(config, name, scope) : undefined;
  const dirty = unsaved(saved, draft);
  useEffect(() => {
    onDirty?.(dirty ? name : null);
  }, [onDirty, dirty, name]);

  const show = useCallback((next: Open) => {
    setOpen(next);
    setArmed(false);
    setConfirmDelete(false);
  }, []);

  useEffect(() => {
    Promise.all([api<ConfigFile>("/api/config"), api<PipelineListing[]>("/api/pipelines")]).then(
      ([file, list]) => {
        if (!alive.current) return;
        setConfig(file.config);
        setPipelines(list);
        show(pick(file.config, start, options.scope ?? null));
      },
      (e: unknown) => alive.current && setFailed(message(e)),
    );
    // Read once: the drawer is mounted afresh for each open, and a save answers with the config it wrote.
  }, []);

  // Config changed elsewhere: show it, keeping an edit under way.
  useEvents(["config"], () => {
    api<ConfigFile>("/api/config").then(
      (file) => {
        if (!alive.current) return;
        setConfig(file.config);
        if (!dirty) setOpen(pick(file.config, name, scope));
      },
      () => undefined,
    );
  });

  const leave = () => !dirty || confirm(`Drop the unsaved changes to ${name}?`);
  const close = () => leave() && onClose();
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && latestClose.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /** Runs one action, showing a refusal in the drawer itself; `then` gets what the API answered. */
  const act = async <T,>(key: string, run: () => T | Promise<T>, then: (res: T) => void) => {
    setBusy(key);
    setError(null);
    try {
      const res = await run();
      if (alive.current) then(res);
    } catch (e) {
      if (!alive.current) return;
      setError(message(e));
      if (e instanceof ApiError && e.body && typeof e.body === "object" && "confirm" in e.body && e.body.confirm) setConfirmDelete(true);
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const savedConfig = (file: ConfigFile, to: string | null, at: string | null) => {
    setConfig(file.config);
    options.onChange?.(file.config);
    show(pick(file.config, to, at));
  };
  const button = (key: string, base = "") => ({ className: [base, busy === key ? "busy" : ""].filter(Boolean).join(" ") || undefined, disabled: busy === key });

  const closeButton = (
    <button type="button" className="sm" data-role="profile-close" onClick={close}>
      Close
    </button>
  );
  const errorLine = (
    <p className="notice" data-role="profile-error" hidden={!error}>
      {error}
    </p>
  );

  if (failed) {
    return (
      <aside className="pf-drawer" data-role="profile-drawer" role="dialog" aria-label="Agent Profiles">
        <section>
          <p className="notice">{failed}</p>
          <button type="button" className="sm" onClick={onClose}>
            Close
          </button>
        </section>
      </aside>
    );
  }
  if (!config) return <aside className="pf-drawer" data-role="profile-drawer" role="dialog" aria-label="Agent Profiles" />;

  const index = profileIndex(config);
  // + New copies the open tab's draft into the same scope: a global profile, or one only that repo has.
  const where = scope === null ? "" : ` in repo ${scope}`;
  const addNew = () => {
    const ask = (name ? `Name for a copy of ${name} (e.g. ${name}-high)` : "Name for the new profile") + where;
    const fresh = (prompt(ask) ?? "").trim();
    if (!fresh) return;
    const profile = draft ? profileOf(draft) : { runner: "claude" };
    const at = name ? scope : null;
    void act("new", () => api<ConfigFile>(profileRoute(fresh, at), { method: "PUT", body: JSON.stringify({ profile, create: true }) }), (res) => savedConfig(res, fresh, at));
  };
  const nav = (
    <nav data-role="profile-nav">
      <div className="eyebrow">profiles</div>
      {index.map((e) => (
        <a key={e.name} className={e.name === name ? "on" : undefined} data-profile={e.name} onClick={() => e.name !== name && leave() && show(pick(config, e.name, null))}>
          <span>
            {e.name}
            {e.global && e.name === config.default_profile && <span className="default">default</span>}
            {!e.global && <span className="pf-scope">{scopeNote(e)}</span>}
          </span>
          <span className="why">
            {profileLine(scopedProfile(config, e.name, e.global ? null : e.repos[0])!, "headless")
              .split(" · ")
              .slice(0, 2)
              .join(" · ")}
          </span>
        </a>
      ))}
      <button type="button" {...button("new", "sm")} data-role="profile-new" title={(name ? `a new profile, copied from ${name}` : "a new profile") + where} onClick={addNew}>
        + New
      </button>
    </nav>
  );

  if (!name || !draft) {
    return (
      <aside className="pf-drawer" data-role="profile-drawer" role="dialog" aria-label="Agent Profiles">
        {nav}
        <section data-role="profile-editor">
          <div className="bar">
            <h2>Agent Profiles</h2>
            <span style={{ flex: 1 }} />
            {closeButton}
          </div>
          {errorLine}
          <p className="empty">No profiles yet: + New makes one.</p>
        </section>
      </aside>
    );
  }

  const entry = index.find((e) => e.name === name)!;
  const repoCfg = scope === null ? null : config.repos[scope];
  // The default this tab sets: config's default_profile on the global tab, the repo's own on a repo's tab.
  const isDefault = repoCfg ? repoCfg.default_profile === name : name === config.default_profile;
  const makeDefault = () =>
    act(
      "default",
      () => api<ConfigFile>(scope === null ? "/api/config" : `/api/repos/${encodeURIComponent(scope)}`, { method: "PATCH", body: JSON.stringify({ default_profile: name }) }),
      (res) => savedConfig(res, name, scope),
    );
  const repos = overridableRepos(entry, config);
  const overrideFor = (repo: string) => {
    if (!repo || !leave()) return;
    void act("override", () => api<ConfigFile>(profileRoute(name, repo), { method: "PUT", body: JSON.stringify({ profile: config.profiles[name], create: true }) }), (res) => savedConfig(res, name, repo));
  };
  const scopeLine =
    scope === null
      ? entry.repos.length
        ? `${scopeNote(entry)}: ${entry.repos.length > 1 ? "those repos run their own" : "that repo runs its own"}`
        : "every repo runs this definition"
      : entry.global
        ? `repo ${scope}'s own ${name}: it replaces the global one whole for ${scope}'s Tickets`
        : `only repo ${scope} has ${name}`;
  const users = profileUsers(name, pipelines, repoCfg ? repoCfg.default_profile || config.default_profile : config.default_profile);
  const warnings = profileWarnings(profileOf(draft));
  const save = () => act("save", () => api<ConfigFile>(profileRoute(name, scope), { method: "PUT", body: JSON.stringify({ profile: profileOf(draft) }) }), (res) => savedConfig(res, name, scope));
  // On a repo's tab over a global profile, removing the override returns the repo to the global one.
  const override = scope !== null && entry.global;
  const remove = () => {
    if (!armed) return setArmed(true);
    void act("delete", () => api<ConfigFile>(profileRoute(name, scope) + (confirmDelete ? "?confirm=1" : ""), { method: "DELETE" }), (res) => savedConfig(res, name, null));
  };
  const removeLabel = confirmDelete ? "Delete anyway" : armed ? (override ? "Remove for sure" : "Delete for sure") : override ? "Remove override" : "Delete";
  const removeLocked = isDefault && !override;
  const removeTitle = override ? `${scope} goes back to the global ${name}` : !removeLocked ? "" : scope === null ? "the default profile; make another the default first" : `${scope}'s default profile; make another its default first`;
  const extra = options.extra?.(name, config, scope) ?? null;
  const choose = (choice: DrawerChoice) => leave() && void act(`choice:${choice.role}`, choice.act, onClose);

  return (
    <aside className="pf-drawer" data-role="profile-drawer" role="dialog" aria-label="Agent Profiles">
      {nav}
      <section data-role="profile-editor">
        <div className="bar">
          <h2>{name}</h2>
          {isDefault && <span className="default">{scope === null ? "default profile" : `${scope}'s default profile`}</span>}
          {!isDefault && (
            <button type="button" {...button("default", "sm")} data-role="profile-default" onClick={() => void makeDefault()}>
              {scope === null ? "Make default" : `Make ${scope}'s default`}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {closeButton}
        </div>
        {options.context && (
          <div className="why" data-role="profile-context">
            {options.context}
          </div>
        )}
        <div className="pf-tabs" role="tablist" data-role="profile-scopes">
          {profileScopes(entry).map((t) => (
            <button
              key={t.repo ?? ""}
              type="button"
              role="tab"
              className={t.repo === scope ? "sm on" : "sm"}
              aria-selected={t.repo === scope}
              data-role="profile-scope-tab"
              data-scope={t.repo ?? ""}
              onClick={() => t.repo !== scope && leave() && show(pick(config, name, t.repo))}
            >
              {t.label}
            </button>
          ))}
          {repos.length > 0 && (
            <select className="sm" data-role="profile-override" aria-label="Override for repo" title={`copy the global ${name} into a repo's profiles:, to edit for that repo alone`} value="" disabled={busy === "override"} onChange={(ev) => overrideFor(ev.target.value)}>
              <option value="">Override for repo…</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="why" data-role="profile-scope-line">
          {scopeLine}
        </div>
        <div className="why" data-role="used-by">
          {(scope === null ? "" : `in ${scope}, `) + usedByLine(users)}
        </div>
        {errorLine}
        <ProfileFields draft={draft} onChange={(next) => setOpen({ ...open, draft: next })} />
        <ul className="pf-warn" data-role="profile-warnings" hidden={!warnings.length}>
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
        {extra && (
          <div className="bar" data-role={extra.role}>
            {extra.choices.map((c) => (
              <button key={c.role} type="button" {...button(`choice:${c.role}`, c.primary ? "primary" : "")} data-role={c.role} hidden={c.hidden} onClick={() => choose(c)}>
                {c.label}
              </button>
            ))}
            {extra.why && <span className="why">{extra.why}</span>}
          </div>
        )}
        <div className="bar">
          <button type="button" {...button("save", "primary")} data-role="profile-save" onClick={() => void save()}>
            Save
          </button>
          <button type="button" {...button("delete")} disabled={busy === "delete" || removeLocked} data-role="profile-delete" title={removeTitle || undefined} onClick={remove}>
            {removeLabel}
          </button>
          <span className="why">blank keeps the Runner's default; saved to config.yaml, used from the next Session</span>
        </div>
      </section>
    </aside>
  );
}
