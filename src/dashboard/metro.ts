// The Metro flow diagram, its mini track for the Ledger, and the small pure helpers the dashboard needs, built from
// the API's Ticket views as SVG strings. Pure on purpose: React components call it, and the tests run the same module
// in Node against real API data (LASSO-41, the composed variant D of the dashboard prototype).

import type { DisplayState, PipelineListing, RouteArcView, SessionView, StageProfileView, TicketView, Trigger } from "../api/views.ts";
import type { TickStatus } from "../server/tick.ts";
import type { Config, ProfileConfig, ProfileScope } from "../server/config.ts";
import type { RunnerName } from "../pipeline/load.ts";

/** A Ticket as the diagram reads it: the Ledger's view, with the Sessions and Route arcs the detail adds. */
export type MetroTicket = TicketView & { sessions?: SessionView[]; arcs?: RouteArcView[] };

type Colour = "good" | "crit" | "warn" | "run" | "accent" | "muted" | "done";

/** The colour key each display state paints the current station and the track behind it. */
export const STATE_COLOUR: Record<DisplayState, Colour> = { flagged: "crit", needs_you: "warn", holding: "warn", ready: "warn", running: "run", queued: "run", watching: "accent", quiet: "good", done: "good", abandoned: "muted" };
const OUTCOME_COLOUR: Record<string, Colour> = { succeeded: "good", failed: "crit", exhausted: "crit", interrupted: "warn" };
const COL: Record<Colour, string> = { good: "var(--good)", crit: "var(--crit)", warn: "var(--amber)", run: "var(--run)", accent: "var(--accent)", muted: "var(--line)", done: "var(--good)" };
// Stages behind the current one are drawn in the text colour: settled, not a status.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]!);

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m" + (s % 60) + "s" : Math.floor(m / 60) + "h" + (m % 60) + "m";
}

/** Whole seconds in a span of milliseconds, never below zero. */
const wholeSeconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

/** How long ago a timestamp was, at second, minute or hour scale. */
export function relative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const s = wholeSeconds(now - new Date(iso).getTime());
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  return m < 60 ? m + "m ago" : Math.round(m / 60) + "h ago";
}

/** How long past its due time a Tick may start before the dot calls it late. */
export const TICK_GRACE_MS = 5_000;

/** What the nav's status dot shows: green while connected and ticking on time, orange when a Tick is overdue, grey when Lasso is unreachable. */
export type TickHealth = "healthy" | "running" | "late" | "down";

/**
 * The nav's status dot ('down' in place of a status while Lasso is unreachable): its state, the word its popover leads
 * with, and the line under it saying when the last Tick ran and the next is due, or why something is wrong.
 */
export function tickIndicator(status: TickStatus | "down", now: number): { state: TickHealth; label: string; detail: string } {
  if (status === "down") return { state: "down", label: "Not connected", detail: "Can't reach Lasso; reconnecting on its own" };
  if (status.running) return { state: "running", label: "Healthy", detail: "tick running" };
  if (!status.lastTick) return { state: "healthy", label: "Healthy", detail: "no tick yet" };
  const last = "last tick " + relative(status.lastTick, now);
  if (!status.nextTick) return { state: "healthy", label: "Healthy", detail: last + " · next: manual" };
  const overdue = now - new Date(status.nextTick).getTime();
  if (overdue > TICK_GRACE_MS) return { state: "late", label: "Tick delayed", detail: last + " · next was due " + relative(status.nextTick, now) + "; ticks run every " + status.tickSeconds + "s" };
  return { state: "healthy", label: "Healthy", detail: last + " · next in " + wholeSeconds(-overdue) + "s" };
}

/**
 * The Session header's "profile (model)" and the hover listing what it ran with, all from the Session's own record;
 * a Session from before Agent Profiles shows its Runner only, and an action Session nothing (null).
 */
export function sessionProfile(s: SessionView): { text: string; title: string } | null {
  const p = s.profile;
  if (!p) return s.runner ? { text: s.runner, title: "runner " + s.runner + " · from before Agent Profiles" } : null;
  return {
    text: p.model ? p.name + " (" + p.model + ")" : p.name,
    title: ["runner " + p.runner, "effort " + (p.effort || "default"), "permission " + (p.permission || "default"), "args " + (p.args.length ? p.args.join(" ") : "none")].join(" · "),
  };
}

/** What one Stage of a Ticket is: done (or skipped), current, or ahead, with its Sessions (newest first, as the API lists them). */
export function stageInfo(t: MetroTicket, index: number) {
  const stage = t.stages[index]!;
  const sessions = (t.sessions || []).filter((s) => s.stage === stage.name);
  const done = t.state === "done" || index < t.stage.index;
  const cur = t.state === "active" && index === t.stage.index;
  const rounds = sessions.filter((s) => s.round !== null);
  return {
    stage,
    done,
    // Passed over by a human's Skip (LASSO-159): done, without its artifact.
    skipped: done && stage.skippedAt !== null,
    cur,
    ahead: !done && !cur,
    sessions,
    // A terminal Session stays open until the human marks the Stage done; only a headless one is Lasso's work in flight.
    running: sessions.some((s) => s.running && s.mode === "headless"),
    last: sessions[0] || null,
    attempts: sessions.filter((s) => s.mode !== "action" && s.round === null),
    roundsUsed: rounds.reduce((max, s) => Math.max(max, s.round!), 0),
  };
}

/** The Sessions timeline filtered to one station, or all of them. */
export function sessionsForStage(sessions: SessionView[], stage: string | null): SessionView[] {
  return stage ? sessions.filter((s) => s.stage === stage) : sessions;
}

/** The one quick action a Ledger row offers: the attention trigger, else Check now when Watching, else Check PR now at a repeating Stage with an Owned PR. */
export function quickAction(t: TicketView): { action: Trigger["action"] | "check"; label: string } | null {
  const primary = t.triggers.find((x) => x.action === "retry" || x.action === "start" || x.action === "terminal");
  if (primary) return primary;
  // A Watching Ticket's Check now runs its wait Stage's check on a Tick.
  const check = t.triggers.find((x) => x.action === "check");
  if (check) return check;
  if (t.state === "active" && t.prs.some((p) => p.role === "owned") && t.stage.repeat) return { action: "check", label: "Check PR now" };
  return null;
}

function markers(): string {
  return (
    "<defs>" +
    Object.entries(COL)
      .map(([k, v]) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10z" fill="${v}"/></marker>`)
      .join("") +
    "</defs>"
  );
}

function prIcon(c: string): string {
  return `<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="-6" cy="-6" r="2.6"/><circle cx="-6" cy="6" r="2.6"/><circle cx="6" cy="6" r="2.6"/><path d="M-6 -3.4v6.8M6 3.4V0a4 4 0 0 0-4-4h-3.5"/><path d="M1 -6.5L-1.5 -4L1 -1.5"/></g>`;
}

function octagon(cx: number, cy: number, r: number): string {
  const p: string[] = [];
  for (let j = 0; j < 8; j++) {
    const a = Math.PI / 8 + (j * Math.PI) / 4;
    p.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1));
  }
  return p.join(" ");
}

/** The Ledger's mini track: a station per Stage, action Stages as ticks, the current one ringed in the state's colour. */
export function metroTrack(t: TicketView): string {
  let px = 6;
  const pts = t.stages.map((s) => {
    const p = { s, cx: px };
    px += s.kind === "action" ? 10 : 20;
    return p;
  });
  if (!pts.length) return `<svg viewBox="0 0 20 18" preserveAspectRatio="xMinYMid meet" data-role="track"></svg>`;
  const ci = t.stage.index;
  const state = STATE_COLOUR[t.display.state] || "muted";
  const first = pts[0]!.cx;
  let o = `<svg viewBox="0 0 ${px} 18" preserveAspectRatio="xMinYMid meet" data-role="track" aria-label="${esc(t.stage.label)}, Stage ${ci + 1} of ${pts.length}"><line x1="${first}" y1="9" x2="${pts[pts.length - 1]!.cx}" y2="9" stroke="var(--surface2)" stroke-width="3"/>`;
  const reach = t.state === "done" ? pts.length - 1 : Math.max(0, Math.min(ci, pts.length - 1));
  if (reach > 0) o += `<line x1="${first}" y1="9" x2="${pts[reach]!.cx}" y2="9" stroke="${t.state === "abandoned" ? "var(--line)" : COL.done}" stroke-width="3" opacity=".85"/>`;
  pts.forEach(({ s, cx }, i) => {
    const done = t.state === "done" || i < ci,
      cur = t.state === "active" && i === ci;
    if (s.kind === "action") {
      o += `<rect x="${cx - 1}" y="5" width="2" height="8" fill="${done ? COL.done : "var(--line)"}"/>`;
      return;
    }
    const c = done ? COL.done : cur ? COL[state] : "var(--line)";
    if (done && s.skippedAt !== null) {
      o += `<circle class="skipped" cx="${cx}" cy="9" r="4" fill="var(--surface)" stroke="${c}" stroke-width="2" stroke-dasharray="2 1.5"/>`;
      return;
    }
    o += cur
      ? `<circle class="current" cx="${cx}" cy="9" r="5" fill="var(--surface)" stroke="${c}" stroke-width="2.5"/><circle cx="${cx}" cy="9" r="2" fill="${c}"/>`
      : `<circle class="${done ? "done" : "ahead"}" cx="${cx}" cy="9" r="4" fill="${done ? c : "var(--surface)"}" stroke="${c}" stroke-width="2"/>`;
  });
  return o + "</svg>";
}

/** The Pipelines list's small line of a Pipeline's Stages: a ring for a Runner or human Stage, a square for an action Stage. */
export function pipelineLine(stages: Array<{ kind: string }>): string {
  let x = 5;
  const pts = stages.map((s) => {
    const p = { s, x };
    x += s.kind === "action" ? 9 : 14;
    return p;
  });
  const w = (pts.length ? pts[pts.length - 1]!.x : 0) + 5;
  let o = `<svg viewBox="0 0 ${w} 12" width="${w}" height="12" aria-hidden="true"><line x1="5" y1="6" x2="${w - 5}" y2="6" stroke="var(--line)" stroke-width="2"/>`;
  for (const { s, x: cx } of pts)
    o += s.kind === "action" ? `<rect x="${cx - 3}" y="3" width="6" height="6" rx="1.5" fill="var(--muted)"/>` : `<circle cx="${cx}" cy="6" r="3.6" fill="var(--bg)" stroke="var(--run)" stroke-width="2"/>`;
  return o + "</svg>";
}

/**
 * The detail's Metro flow diagram: a thick track, station circles for done, current and ahead
 * Stages, action Stages as ticks, a red octagon for Flagged, the PR feedback orbit with its
 * Rounds badge, a small orbit counting attempts, a pulsing ring while running, and no
 * travelling dot. Each station is a node with data-stage, for the timeline filter. Stations
 * sit as far apart as their labels need; given the panel's `width`, they spread across it.
 */
export function metroDiagram(t: MetroTicket, focus: string | null, width: number | null = null, arc: string | null = null): string {
  if (!t.stages.length) return `<svg viewBox="0 0 100 40" role="img" aria-label="no Stages"><text x="0" y="20" class="sub">This Pipeline does not load.</text></svg>`;
  const infos = t.stages.map((_, i) => stageInfo(t, i));
  const reach = infos.map(stationReach);
  const arcs = (t.arcs ?? []).filter((a) => t.stages.some((s) => s.name === a.from) && t.stages.some((s) => s.name === a.to));
  // A band over everything else for the Route arcs, a lane for each; nothing when none has fired.
  const band = arcs.length ? ARC_FIRST + ARC_LANE * (arcs.length - 1) + 14 : 0;
  // Room above the track only for what is drawn there: the Rounds orbit, an attempts orbit, or a line of text.
  const baseY = band + (infos.some((inf) => inf.roundsUsed) ? 66 : infos.some((inf) => inf.attempts.length > 1) ? 44 : 34);
  const H = baseY + (infos.some((inf) => inf.roundsUsed || inf.attempts.length > 1) ? 50 : 40);
  // Adjacent stations sit far enough apart that their labels clear each other.
  const gaps = reach.slice(1).map((r, i) => Math.max(reach[i]!.right + r.left + 18, 56));
  const natural = reach[0]!.left + gaps.reduce((a, b) => a + b, 0) + reach[reach.length - 1]!.right + 24;
  // A wider panel spreads the stations out, up to a point, and centres what is left over.
  const spare = width && width > natural ? width - natural : 0;
  const spread = gaps.length ? Math.min(spare / gaps.length, 180) : 0;
  const W = Math.max(natural, width || 0);
  let x = (W - natural - spread * gaps.length) / 2 + reach[0]!.left + 12;
  const pts = t.stages.map((s, i) => {
    const p = { s, i, cx: Math.round(x) };
    x += (gaps[i] || 0) + spread;
    return p;
  });
  const ci = t.stage.index;
  const active = t.state === "active";
  const state = STATE_COLOUR[t.display.state] || "muted";
  let out = markers();
  out += `<line x1="${pts[0]!.cx}" y1="${baseY}" x2="${pts[pts.length - 1]!.cx}" y2="${baseY}" stroke="var(--surface2)" stroke-width="6" stroke-linecap="round"/>`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!,
      b = pts[i + 1]!;
    const k = i + 1 < ci || t.state === "done" ? "done" : i + 1 === ci && active ? state : "muted";
    if (k === "muted") out += `<line class="segment ahead" x1="${a.cx + 14}" y1="${baseY}" x2="${b.cx - 14}" y2="${baseY}" stroke="var(--line)" stroke-width="6" stroke-linecap="round" stroke-dasharray="1 10"/>`;
    else out += `<line class="segment" x1="${a.cx}" y1="${baseY}" x2="${b.cx}" y2="${baseY}" stroke="${COL[k]}" stroke-width="6" stroke-linecap="round" opacity="${k === "done" ? ".85" : "1"}"/>`;
  }
  pts.forEach(({ s, i, cx }) => {
    const inf = infos[i]!;
    const sel = focus === s.name;
    const name = esc(s.label);
    if (s.kind === "action") {
      const c = inf.done ? COL.done : inf.cur ? COL.accent : "var(--muted)";
      out += `<g class="node action${sel ? " focus" : ""}" data-stage="${esc(s.name)}"><rect x="${cx - 1.5}" y="${baseY - 9}" width="3" height="18" rx="1.5" fill="${c}"/><text class="act" x="${cx}" y="${baseY + 26}" text-anchor="middle">${name}</text><title>action Stage: ${name}</title></g>`;
      return;
    }
    const c = inf.done ? COL.done : inf.cur ? COL[state] : "var(--muted)";
    let shape = "";
    if (sel) shape += `<circle class="focus-ring" cx="${cx}" cy="${baseY}" r="18" fill="none" stroke="${COL.accent}" stroke-width="2" stroke-dasharray="3 3"/>`;
    if (inf.cur && t.flag) shape += `<polygon class="flagged" points="${octagon(cx, baseY, 13)}" fill="${COL.crit}" stroke="var(--surface)" stroke-width="2"/><text x="${cx}" y="${baseY + 4.5}" text-anchor="middle" class="bang">!</text>`;
    else if (inf.skipped)
      shape += `<circle class="skipped" cx="${cx}" cy="${baseY}" r="11" fill="var(--surface)" stroke="${COL.done}" stroke-width="3" stroke-dasharray="4 3"/><path d="M${cx - 5} ${baseY - 4} l4 4 l-4 4 M${cx + 1} ${baseY - 4} l4 4 l-4 4" fill="none" stroke="${COL.done}" stroke-width="2"/><title>Skipped</title>`;
    else if (inf.done) shape += `<circle class="done" cx="${cx}" cy="${baseY}" r="11" fill="${COL.done}" stroke="var(--surface)" stroke-width="2"/><path d="M${cx - 5} ${baseY} l3.5 3.5 l6.5 -7" fill="none" stroke="var(--surface)" stroke-width="2.2"/>`;
    else if (inf.cur) shape += `<circle class="current${inf.running ? " pulse" : ""}" cx="${cx}" cy="${baseY}" r="11" fill="var(--surface)" stroke="${c}" stroke-width="3.5"/><circle cx="${cx}" cy="${baseY}" r="4.5" fill="${c}"/>`;
    else shape += `<circle class="ahead" cx="${cx}" cy="${baseY}" r="9" fill="var(--surface)" stroke="var(--line)" stroke-width="3"/>`;
    const cls = inf.skipped ? "done skipped" : inf.done ? "done" : inf.cur ? "current" : "ahead";
    out += `<g class="node ${cls}${sel ? " focus" : ""}" data-stage="${esc(s.name)}">${shape}<text x="${cx}" y="${baseY + 30}" text-anchor="middle" class="name${inf.cur ? " cur" : ""}${inf.ahead ? " dim" : ""}">${name}</text>`;
    if (inf.roundsUsed) {
      // The PR feedback orbit: Rounds of a repeating Stage, with Rounds used of the Budget on its badge.
      const lk: Colour = inf.running ? "run" : inf.cur && t.flag ? "crit" : "good";
      const oc = COL[lk],
        oy = baseY - 31;
      out +=
        `<path class="orbit rounds" d="M${cx + 8} ${baseY - 8} A24 24 0 1 0 ${cx - 8} ${baseY - 8}" fill="none" stroke="${oc}" stroke-width="2.5" marker-end="url(#arr-${lk})"/>` +
        `<g transform="translate(${cx},${oy})">${prIcon(oc)}<title>PR feedback drives Rounds of ${name}</title></g>` +
        `<g class="badge" transform="translate(${cx + 30},${oy})"><rect x="0" y="-9" width="84" height="18" rx="9" fill="${oc}"/><text x="42" y="4" text-anchor="middle" class="badge-text">${inf.roundsUsed} of ${t.budget.rounds.limit} Rounds</text><title>Rounds used of Budget</title></g>` +
        `<text class="sub" x="${cx}" y="${baseY + 43}" text-anchor="middle">${inf.running ? `Round ${inf.roundsUsed} running` : `${inf.roundsUsed} Round${inf.roundsUsed === 1 ? "" : "s"}`}</text>`;
    } else if (inf.attempts.length > 1) {
      const lk: Colour = inf.running ? "run" : (inf.last!.outcome && OUTCOME_COLOUR[inf.last!.outcome]) || "warn";
      const oc = COL[lk];
      out +=
        `<path class="orbit attempts" d="M${cx + 7} ${baseY - 9} A14 14 0 1 0 ${cx - 7} ${baseY - 9}" fill="none" stroke="${oc}" stroke-width="2.5" marker-end="url(#arr-${lk})"/><text x="${cx}" y="${baseY - 17}" text-anchor="middle" class="count" style="fill:${oc}">${inf.attempts.length}</text>` +
        `<text class="sub" x="${cx}" y="${baseY + 43}" text-anchor="middle">${inf.attempts.length} of ${t.budget.attempts.limit} attempts</text>`;
    } else {
      const above = aboveText(t, inf);
      if (above) out += `<text class="sub" x="${cx}" y="${baseY - 20}" text-anchor="middle">${esc(above)}</text>`;
    }
    out += "</g>";
  });
  if (arcs.length) {
    const xOf = new Map(pts.map((p) => [p.s.name, p.cx]));
    out += routeArcsSvg(arcs, xOf, band, W, arc);
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Stage flow for ${esc(t.label)}">${out}</svg>`;
}

/** The lowest arc's height over the band's foot, and the rise from one lane to the next. */
const ARC_FIRST = 24;
const ARC_LANE = 22;
/** How far right of a station's centre an arc leaves it, and how far left one arrives. */
const ARC_LEG = 6;

/**
 * The Route arcs (LASSO-199), from source station to target over a band at the top of the diagram: the shortest in
 * the lowest lane, so arcs nest. Each is labelled at its peak with the Route's name and used/limit, red once spent; a
 * human's sends are a dashed amber arc with no Budget. A loop to its own Stage is a small arc over that station.
 * Each arc is a node with data-arc for the Route records panel; `selected` draws its key heavier.
 */
function routeArcsSvg(arcs: RouteArcView[], xOf: Map<string, number>, foot: number, W: number, selected: string | null): string {
  const span = (a: RouteArcView) => Math.abs(xOf.get(a.from)! - xOf.get(a.to)!);
  const lanes = [...arcs].sort((a, b) => span(a) - span(b));
  let out = "";
  lanes.forEach((a, lane) => {
    const sx = xOf.get(a.from)!,
      tx = xOf.get(a.to)!;
    const h = ARC_FIRST + ARC_LANE * lane;
    // A cubic's peak sits at three quarters of its control points' rise.
    const rise = (h * 4) / 3;
    // Arcs leave a station just right of its centre and arrive just left of it, so a pair going opposite ways between
    // the same Stages never share a leg; a loop to its own Stage leaves and arrives the same way, swelling out to fit.
    const [x1, x2] = [sx + ARC_LEG, tx - ARC_LEG];
    const [c1, c2] = sx === tx ? [sx + 40, sx - 40] : [x1, x2];
    const d = `M${x1} ${foot} C${c1} ${foot - rise} ${c2} ${foot - rise} ${x2} ${foot}`;
    const send = a.kind === "send";
    const sel = a.key === selected;
    const colour: Colour = send ? "warn" : "accent";
    const name = send ? "sent by you" + (a.records.length > 1 ? ` ×${a.records.length}` : "") : a.route!;
    const badge = !send && a.budget ? `${a.budget.used}/${a.budget.limit}` : "";
    const nameW = Math.round(name.length * 6.2) + 14;
    const badgeW = badge ? Math.round(badge.length * 6) + 10 : 0;
    const w = nameW + badgeW;
    const mid = (sx + tx) / 2;
    const top = foot - h;
    const what = send ? `Sent by you from ${a.from} to ${a.to}` : `Route ${a.route} from ${a.from} to ${a.to}` + (a.budget ? `, taken ${a.budget.used} of ${a.budget.limit}` + (a.spent ? " (spent)" : "") : "");
    out +=
      `<g class="arc ${a.kind}${a.spent ? " spent" : ""}${sel ? " sel" : ""}" data-arc="${esc(a.key)}">` +
      `<path d="${d}" fill="none" stroke="transparent" stroke-width="12"/>` +
      `<path d="${d}" fill="none" stroke="${COL[colour]}" stroke-width="${sel ? 3 : 1.8}"${send ? ` stroke-dasharray="5 4"` : ""} marker-end="url(#arr-${colour})"/>` +
      `<g transform="translate(${Math.round(Math.min(Math.max(mid - w / 2, 2), W - w - 2))},${top})"><rect x="0" y="-9" width="${w}" height="18" rx="9" fill="var(--surface)" stroke="${COL[colour]}" stroke-width="${sel ? 2 : 1}"/>` +
      `<text class="arc-name" x="${nameW / 2}" y="4" text-anchor="middle">${esc(name)}</text>` +
      (badge ? `<g class="arc-badge"><rect x="${nameW - 4}" y="-7" width="${badgeW}" height="14" rx="7" fill="${a.spent ? COL.crit : COL[colour]}"/><text class="badge-text" x="${nameW - 4 + badgeW / 2}" y="3.5" text-anchor="middle">${badge}</text></g>` : "") +
      `</g><title>${esc(what)}</title></g>`;
  });
  return out;
}

type StationInfo = ReturnType<typeof stageInfo>;

/** The line over a station with no orbit: how long its last Session ran, and its cost, or the Ticket's state when current. */
function aboveText(t: MetroTicket, inf: StationInfo): string {
  if (inf.skipped) return "skipped";
  if (inf.last) return (inf.running ? "running" : duration(inf.last.durationMs)) + (inf.last.costUsd === null ? "" : " · $" + inf.last.costUsd.toFixed(2));
  return inf.cur ? t.display.label.toLowerCase() : "";
}

/**
 * How far a station's drawing reaches left and right of its centre, from its widest text at rough per-character
 * widths for each font size; the Rounds badge reaches further right.
 */
function stationReach(inf: StationInfo): { left: number; right: number } {
  const label = inf.stage.label.length;
  if (inf.stage.kind === "action") return { left: (label * 5.8) / 2, right: (label * 5.8) / 2 };
  const below = inf.roundsUsed ? `Round ${inf.roundsUsed} running`.length : inf.attempts.length > 1 ? "10 of 10 attempts".length : 0;
  const above = inf.roundsUsed || inf.attempts.length > 1 ? 0 : 18;
  const half = Math.max(label * 7.2, below * 6.2, above * 6.2, 28) / 2;
  return { left: half, right: inf.roundsUsed ? Math.max(half, 116) : half };
}

// Agent Profiles (ADR 0011): what the Config list and the profile drawer say about a profile, from
// config as /api/config returns it and the Pipelines as /api/pipelines lists them (LASSO-72).

type Mode = "headless" | "human";

/** The model aliases the drawer suggests per Runner; any other text is passed on as written. */
export const MODEL_SUGGESTIONS: Record<RunnerName, string[]> = {
  claude: ["fable", "opus", "sonnet", "haiku"],
  codex: ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"],
  pi: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
};

/** The permission each Runner's adapter starts a mode with when the profile sets none (null: no permission layer). */
const BASELINE_PERMISSION: Record<RunnerName, Record<Mode, string | null>> = { claude: { headless: "auto", human: "edits" }, codex: { headless: "edits", human: "edits" }, pi: { headless: null, human: null } };

/** Whether a field does anything on a Runner: Pi has no permission layer, and only Codex reads skills_dir. */
export function profileApplies(runner: string, field: string): boolean {
  if (field === "permission") return runner !== "pi";
  if (field === "skills_dir") return runner === "codex";
  return true;
}

/** One mode's settings as a Session of that mode runs them. */
export interface ModeSettings {
  runner: RunnerName;
  model: string | null;
  effort: string | null;
  permission: string | null;
  /** True when the permission is the one the adapter supplies, not one the profile sets. */
  baseline: boolean;
  args: string[];
}

/**
 * A profile with one mode's block merged in, as a Session of that mode runs it: the block's model, effort and
 * permission replace the shared ones, and its args follow. `baseline` marks a permission the adapter supplies.
 */
export function profileMode(p: ProfileConfig, mode: Mode): ModeSettings {
  const block = p[mode] || {};
  const set = block.permission || p.permission || null;
  const permission = !profileApplies(p.runner, "permission") ? null : set || BASELINE_PERMISSION[p.runner]?.[mode] || null;
  return {
    runner: p.runner,
    model: block.model || p.model || null,
    effort: block.effort || p.effort || null,
    permission,
    baseline: !set && permission !== null,
    args: [...(p.args || []), ...(block.args || [])],
  };
}

/** One mode's settings as the parts of a summary line. */
function modeParts(p: ProfileConfig, mode: Mode): string[] {
  const s = profileMode(p, mode);
  return [s.runner, s.model || "model default", "effort " + (s.effort || "default"), !profileApplies(s.runner, "permission") ? "permission n/a" : s.permission + (s.baseline ? " (default)" : ""), s.args.join(" ")];
}

/** One mode's resolved settings on a line: runner · model · effort · permission · args. */
export function profileLine(p: ProfileConfig, mode: Mode): string {
  return modeParts(p, mode).filter(Boolean).join(" · ");
}

/** The Config list's summary: the headless line, then what a human Session runs differently, if anything. */
export function profileSummary(p: ProfileConfig): string {
  const headless = modeParts(p, "headless");
  const human = modeParts(p, "human");
  const differs = human.filter((part, i) => part !== headless[i]).map((part) => part || "no args");
  return profileLine(p, "headless") + (differs.length ? "; human: " + differs.join(" · ") : "");
}

/** A Runner Stage that runs under a profile, and whether it names it or inherits it. */
export interface ProfileUser {
  pipeline: string;
  stage: string;
  inherited: boolean;
}

/**
 * The Runner Stages that run under a profile: those naming it, and those inheriting it from their Pipeline's
 * profile or from config's default_profile. A Pipeline that does not load lists no Stages.
 */
export function profileUsers(name: string, pipelines: PipelineListing[], defaultProfile: string | null): ProfileUser[] {
  const users: ProfileUser[] = [];
  for (const p of pipelines) {
    for (const s of p.stages) {
      if (s.kind !== "runner") continue;
      const resolved = s.profile || p.profile || defaultProfile;
      if (resolved === name) users.push({ pipeline: p.name, stage: s.name, inherited: !s.profile });
    }
  }
  return users;
}

/**
 * The used-by line, a phrase that reads alone: "used by" the Stages naming the profile, then "inherited by" those
 * that inherit it, or "used by no Stages".
 */
export function usedByLine(users: ProfileUser[]): string {
  if (!users.length) return "used by no Stages";
  const list = (xs: ProfileUser[]) => xs.map((u) => u.pipeline + "/" + u.stage).join(", ");
  const named = users.filter((u) => !u.inherited);
  const inherited = users.filter((u) => u.inherited);
  return [named.length ? "used by " + list(named) : "", inherited.length ? "inherited by " + list(inherited) : ""].filter(Boolean).join(" · ");
}

/** Pairs a Runner accepts but does not honour, checked per mode (ADR 0011 keeps a short list, no capability table). */
const BAD_PAIRS: Array<{ applies: (s: ModeSettings) => boolean; text: string }> = [
  { applies: (s) => s.runner === "claude" && /haiku/i.test(s.model || "") && s.permission === "auto", text: "Claude runs Haiku in Manual mode, not auto" },
];

/**
 * The known-bad-pair warnings for a profile, each naming the modes it hits; an unset permission counts as
 * the adapter's default for that mode, so Haiku warns for headless Sessions even with permission unset.
 */
export function profileWarnings(p: ProfileConfig): string[] {
  return BAD_PAIRS.flatMap((pair) => {
    const modes = (["headless", "human"] as const).filter((mode) => pair.applies(profileMode(p, mode)));
    return modes.length ? [pair.text + " (" + modes.join(" and ") + " Sessions)"] : [];
  });
}

/** What a profile button says: the profile, how it got there, and each mode's resolved line. */
export interface ProfileButtonView {
  name: string | null;
  label: string;
  headless: string;
  human: string;
}

/**
 * What a Runner Stage's profile button says (LASSO-73): the profile it runs, "inherit → " when it names none and
 * takes its Pipeline's or config's default_profile, and each mode's resolved line. A name config lacks says so.
 * The Pipeline editor has no repo, so this resolves against the global profiles and default_profile only.
 */
export function stageProfileView(stageProfile: string | null, pipelineProfile: string | null, config: Pick<Config, "profiles" | "default_profile">): ProfileButtonView & { inherited: boolean } {
  const name = stageProfile || pipelineProfile || config.default_profile || null;
  const inherited = !stageProfile;
  const label = (inherited ? "inherit → " : "") + (name || "none");
  const p = name ? config.profiles[name] : undefined;
  const missing = name ? "no profile named " + name + " in config.yaml" : "no profile: config.yaml sets no default_profile";
  return { name, inherited, label, headless: p ? profileLine(p, "headless") : missing, human: p ? profileLine(p, "human") : missing };
}

/**
 * What a Runner Stage's profile button says on the Ticket page (LASSO-75): the profile its next Session runs, marked
 * "overridden" while a human's override stands, and each mode's resolved line; a profile that does not resolve says why.
 */
export function ticketProfileView(v: StageProfileView): ProfileButtonView & { overridden: boolean; summary: string } {
  const headless = v.headless ? profileLine(v.headless, "headless") : v.problem || "";
  const human = v.human ? profileLine(v.human, "human") : v.problem || "";
  const summary = v.headless && v.human ? modeSummary(shortParts(v.headless, "headless"), shortParts(v.human, "human")) : v.problem || "";
  return { name: v.profile, overridden: v.overridden, label: v.profile || "none", headless, human, summary };
}

/** One mode's settings with every default left out, e.g. claude · fable · effort high · auto. */
function shortParts(p: ProfileConfig, mode: Mode): string[] {
  const s = profileMode(p, mode);
  return [s.runner, s.model || "", s.effort ? "effort " + s.effort : "", s.permission || "", s.args.join(" ")];
}

/** Both modes on one line: the headless settings, then only those a human Session runs differently. */
function modeSummary(headless: string[], human: string[]): string {
  const differs = human.filter((part, i) => part !== headless[i]).map((part) => part || "no args");
  return headless.filter(Boolean).join(" · ") + (differs.length ? " · human: " + differs.join(" · ") : "");
}

/**
 * A Ledger row's stage text: the Stage and its place, then the profile with a star only when a human overrode the
 * current Stage's profile, e.g. "plan · 3/8 · claude-fable*". Nothing extra otherwise (LASSO-63). A Stage visited
 * more than once shows the Visit count, and ↩ when a Route began this Visit, e.g. "review-pr ×3 ↩ · 1/4" (LASSO-199);
 * a human's send is not a Route and gets no ↩.
 */
export function ledgerStageText(t: TicketView): string {
  const place = t.stage.index < 0 ? "" : " · " + (t.stage.index + 1) + "/" + t.stages.length;
  const count = t.visit && t.visit.number > 1 ? " ×" + t.visit.number : "";
  const routed = t.visit?.arrivedBy === "route" ? " ↩" : "";
  return t.stage.label + count + routed + place + (t.stage.override ? " · " + t.stage.override + "*" : "");
}

// Repo overrides (LASSO-74): a repo may define its own profile of a global's name, which replaces it whole for that
// repo's Tickets, or one no global has. The Config list and the drawer show both, and the drawer has a tab per scope.

/** A profile config defines: whether config.yaml has it globally, and the repos that define their own of that name. */
export interface ProfileEntry {
  name: string;
  global: boolean;
  repos: string[];
}

/**
 * Every profile config defines, once each: the global ones in config's order, then those only some repo has,
 * each with the repos that define their own of that name.
 */
export function profileIndex(config: ProfileScope): ProfileEntry[] {
  const repos = Object.entries(config.repos || {});
  const reposWith = (name: string) => repos.filter(([, r]) => r.profiles && r.profiles[name]).map(([repo]) => repo);
  const global = Object.keys(config.profiles).map((name) => ({ name, global: true, repos: reposWith(name) }));
  const only = [...new Set(repos.flatMap(([, r]) => Object.keys(r.profiles || {})))].filter((name) => !config.profiles[name]);
  return [...global, ...only.map((name) => ({ name, global: false, repos: reposWith(name) }))];
}

/**
 * What a profile's line says about its scopes: "overridden in app, web" for a global with repo overrides,
 * "only in app" for one no global has, and nothing for a plain global profile.
 */
export function scopeNote(entry: ProfileEntry): string {
  if (!entry.repos.length) return "";
  return (entry.global ? "overridden in " : "only in ") + entry.repos.join(", ");
}

/** The drawer's scope tabs for a profile: "global" when config.yaml defines it there, then each repo with its own. */
export function profileScopes(entry: ProfileEntry): Array<{ repo: string | null; label: string }> {
  return [...(entry.global ? [{ repo: null, label: "global" }] : []), ...entry.repos.map((repo) => ({ repo, label: repo }))];
}

/**
 * The repos "Override for repo…" offers: those configured without their own profile of this name. Only a global
 * profile can be copied into a repo, so a repo-only one offers none.
 */
export function overridableRepos(entry: ProfileEntry, config: ProfileScope): string[] {
  return entry.global ? Object.keys(config.repos || {}).filter((repo) => !entry.repos.includes(repo)) : [];
}

/** The profile one scope defines: the global one, or a repo's own. */
export function scopedProfile(config: ProfileScope, name: string, repo: string | null): ProfileConfig | undefined {
  return repo === null ? config.profiles[name] : config.repos[repo]?.profiles?.[name];
}

/** The route that saves or deletes a profile in one scope. */
export function profileRoute(name: string, repo: string | null): string {
  const scope = repo === null ? "/api" : "/api/repos/" + encodeURIComponent(repo);
  return scope + "/profiles/" + encodeURIComponent(name);
}
