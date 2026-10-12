import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Config, NotificationConfig } from "../../../server/config.ts";
import type { ConfigFile } from "../../../api/views.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { Setting } from "../Setting.tsx";
import { draftOf, FieldError, rebase, settingsPatch, unsaved, type Draft, type TextField } from "./settings.ts";

const FLAG_LABEL: Record<keyof NotificationConfig, string> = {
  enabled: "Send notifications",
  flagged: "A Ticket is Flagged",
  human: "A human Stage is ready for you",
  gate: "A Stage finished and the next waits for Start",
};

/**
 * Budget defaults, server and notifications, saved together with Save changes. When config changes elsewhere,
 * the form shows the new values in every field not edited here, and keeps the edits.
 */
export function SettingsForm({ config, onSaved }: { config: Config; onSaved: (saved: ConfigFile) => void }) {
  const [shown, setShown] = useState(config);
  const [draft, setDraft] = useState(() => draftOf(config));
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  if (shown !== config) {
    setShown(config);
    setDraft(rebase(shown, config, draft));
  }
  const dirty = unsaved(config, draft);

  const text = (field: TextField, label: string, opts: { numeric?: boolean; placeholder?: string } = {}) => (
    <label>
      {label}
      <input name={field} value={draft[field]} inputMode={opts.numeric === false ? undefined : "decimal"} placeholder={opts.placeholder} onChange={(ev) => setDraft({ ...draft, [field]: ev.target.value })} />
    </label>
  );
  // With notifications off, the kinds below it have nothing to say; they keep their values for when it is back on.
  const flag = (key: keyof NotificationConfig): ReactNode => {
    const off = key !== "enabled" && !draft.notifications.enabled;
    return (
      <label key={key} className="check" style={off ? { opacity: 0.5 } : undefined}>
        <input type="checkbox" name={key} checked={draft.notifications[key]} disabled={off} onChange={(ev) => setDraft({ ...draft, notifications: { ...draft.notifications, [key]: ev.target.checked } })} />
        {FLAG_LABEL[key]}
      </label>
    );
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    showNotice("");
    let patch;
    try {
      patch = settingsPatch(config, draft);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      showNotice(error.message);
      form.current?.querySelector<HTMLInputElement>(`[name="${error.field}"]`)?.focus();
      return;
    }
    if (!Object.keys(patch).length) {
      showNotice("nothing changed");
      return;
    }
    setBusy(true);
    try {
      const saved = await api<ConfigFile>("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
      showNotice(saved.restart.length ? `saved; ${saved.restart.join(" and ")} apply after a restart` : "saved");
      setShown(saved.config);
      setDraft(draftOf(saved.config));
      onSaved(saved);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={form} className={dirty ? "sheet dirty" : "sheet"} data-role="config-fields" onSubmit={submit}>
      <Setting title="Budget defaults" about="What every Ticket may use unless its Pipeline or a Stage sets its own.">
        <div className="fields">
          {text("rounds", "Rounds per repeating Stage")}
          {text("attempts", "Attempts per Stage")}
          {text("wallTime", "Time per Session", { numeric: false, placeholder: "30m" })}
          {text("spend", "Spend per Ticket (USD)")}
        </div>
      </Setting>
      <Setting title="Server" about="How often Lasso checks for work, how much it runs at once, and how long it keeps finished Tickets.">
        <div className="fields">
          {text("tick", "Check every (seconds)")}
          {text("concurrency", "Sessions at once")}
          {text("retention", "Keep finished Tickets (days)")}
          {text("branch_prefix", "Branch prefix", { numeric: false, placeholder: "none" })}
          {text("port", "Port")}
        </div>
      </Setting>
      <Setting title="Notifications" about="Desktop notifications for the moments that need you.">
        <div className="fields checks">{(["enabled", "flagged", "human", "gate"] as const).map(flag)}</div>
      </Setting>
      <div className="savebar">
        <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy}>
          Save changes
        </button>
        <span className="state">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <span className="why">Port and check interval apply after a restart; everything else at once.</span>
      </div>
    </form>
  );
}
