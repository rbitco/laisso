import type { Config, NotificationConfig, TerminalSetting } from "../../../server/config.ts";

/** The Settings form as typed: each text field as its raw string, each notification as its checkbox. */
export interface Draft {
  rounds: string;
  attempts: string;
  wallTime: string;
  spend: string;
  routes: string;
  tick: string;
  concurrency: string;
  retention: string;
  port: string;
  branch_prefix: string;
  terminal: TerminalSetting;
  notifications: NotificationConfig;
}

export type TextField = Exclude<keyof Draft, "notifications" | "terminal">;

/** What PATCH /api/config takes from this form: only the keys that changed; null clears a key back to its default. */
export interface SettingsPatch {
  budget?: Partial<Record<"rounds" | "attempts" | "spend" | "routes", number | null> & { wallTime: string | null }>;
  tick?: number | null;
  concurrency?: number | null;
  retention?: number | null;
  port?: number | null;
  branch_prefix?: string | null;
  terminal?: TerminalSetting | null;
  notifications?: Partial<NotificationConfig>;
}

/** A field that does not hold what it must; nothing is sent until it does. */
export class FieldError extends Error {
  readonly field: TextField;

  constructor(field: TextField, message: string) {
    super(message);
    this.field = field;
  }
}

export function draftOf(config: Config): Draft {
  const { budget } = config;
  return {
    rounds: String(budget.rounds),
    attempts: String(budget.attempts),
    wallTime: budget.wallTime,
    spend: String(budget.spend),
    routes: String(budget.routes),
    tick: String(config.tick),
    concurrency: String(config.concurrency),
    retention: String(config.retention),
    port: String(config.port),
    branch_prefix: config.branch_prefix,
    terminal: config.terminal,
    notifications: { ...config.notifications },
  };
}

/** True when the form holds something config.yaml does not. */
export function unsaved(config: Config, draft: Draft): boolean {
  return JSON.stringify(draftOf(config)) !== JSON.stringify(draft);
}

/**
 * The draft once config changed from `was` to `now` elsewhere: each field the person has not touched takes the
 * new value, and each edit stays, so a save cannot undo another client's change to a field nobody edited here.
 */
export function rebase(was: Config, now: Config, draft: Draft): Draft {
  const [before, after] = [draftOf(was), draftOf(now)];
  const next = { ...draft, notifications: { ...draft.notifications } };
  for (const key of Object.keys(after) as (keyof Draft)[]) {
    if (key === "notifications" || key === "terminal") continue;
    if (draft[key] === before[key]) next[key] = after[key];
  }
  if (draft.terminal === before.terminal) next.terminal = after.terminal;
  for (const key of Object.keys(after.notifications) as (keyof NotificationConfig)[]) {
    if (draft.notifications[key] === before.notifications[key]) next.notifications[key] = after.notifications[key];
  }
  return next;
}

function numberOrNull(draft: Draft, field: TextField): number | null {
  const raw = draft[field].trim();
  if (raw === "") return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new FieldError(field, `${field} must be a number`);
  return Number(raw);
}

/** The patch that saves `draft` over `config`: unchanged fields stay out, a blank clears its key. */
export function settingsPatch(config: Config, draft: Draft): SettingsPatch {
  const patch: SettingsPatch = {};
  const budget: NonNullable<SettingsPatch["budget"]> = {};
  for (const key of ["rounds", "attempts", "spend", "routes"] as const) {
    const value = numberOrNull(draft, key);
    if (value !== config.budget[key]) budget[key] = value;
  }
  const wallTime = draft.wallTime.trim() || null;
  if (wallTime !== config.budget.wallTime) budget.wallTime = wallTime;
  if (Object.keys(budget).length) patch.budget = budget;
  for (const key of ["tick", "concurrency", "retention", "port"] as const) {
    const value = numberOrNull(draft, key);
    if (value !== config[key]) patch[key] = value;
  }
  const prefix = draft.branch_prefix.trim() || null;
  if (prefix !== (config.branch_prefix || null)) patch.branch_prefix = prefix;
  // auto is the default: choosing it clears the key rather than writing it.
  if (draft.terminal !== config.terminal) patch.terminal = draft.terminal === "auto" ? null : draft.terminal;
  const notifications: Partial<NotificationConfig> = {};
  for (const key of ["enabled", "flagged", "human", "gate"] as const) {
    if (draft.notifications[key] !== config.notifications[key]) notifications[key] = draft.notifications[key];
  }
  if (Object.keys(notifications).length) patch.notifications = notifications;
  return patch;
}
