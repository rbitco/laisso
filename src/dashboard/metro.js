// The Metro flow diagram, its mini track for the Ledger, and the small
// pure helpers the dashboard needs, built from the API's Ticket views as SVG
// strings. Plain JavaScript on purpose: the page loads it as a module and the
// tests run the same file in Node against real API data (LASSO-41, the
// composed variant D of the dashboard prototype).

/** @typedef {import('../api/views.ts').TicketView} TicketView */
/** @typedef {import('../api/views.ts').TicketDetail} TicketDetail */
/** @typedef {import('../api/views.ts').SessionView} SessionView */
/** @typedef {import('../api/views.ts').Trigger} Trigger */
/** @typedef {import('../server/tick.ts').TickStatus} TickStatus */
/** @typedef {TicketView & { sessions?: SessionView[] }} MetroTicket */

/** The colour key each display state paints the current station and the track behind it. */
export const STATE_COLOUR = { flagged: 'crit', needs_you: 'warn', holding: 'warn', ready: 'warn', running: 'run', queued: 'run', quiet: 'good', done: 'good', abandoned: 'muted' };
const OUTCOME_COLOUR = { succeeded: 'good', failed: 'crit', exhausted: 'crit', interrupted: 'warn' };
const COL = { good: 'var(--good)', crit: 'var(--crit)', warn: 'var(--amber)', run: 'var(--run)', accent: 'var(--accent)', muted: 'var(--line)' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm' + (s % 60) + 's' : Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

/** Whole seconds in a span of milliseconds, never below zero. */
const wholeSeconds = (ms) => Math.max(0, Math.round(ms / 1000));

/**
 * How long ago a timestamp was, at second, minute or hour scale.
 * @param {string | null} iso
 * @param {number} [now]
 */
export function relative(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = wholeSeconds(now - new Date(iso).getTime());
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
}

/**
 * The header's Tick dot: idle, running, or down while Lasso is unreachable ('down' in place of a status), with its tooltip.
 * @param {TickStatus | 'down'} status
 * @param {number} now
 * @returns {{ state: 'idle' | 'running' | 'down', title: string }}
 */
export function tickIndicator(status, now) {
  if (status === 'down') return { state: 'down', title: 'lasso unreachable; reconnecting' };
  if (status.running) return { state: 'running', title: 'tick running' };
  if (!status.lastTick) return { state: 'idle', title: 'no tick yet' };
  const next = status.nextTick ? 'next in ' + wholeSeconds(new Date(status.nextTick).getTime() - now) + 's' : 'next: manual';
  return { state: 'idle', title: 'last tick ' + relative(status.lastTick, now) + ' · ' + next };
}

/**
 * The Session header's "profile (model)" and the hover listing what it ran with, all from the Session's own record;
 * a Session from before Agent Profiles shows its Runner only, and an action Session nothing (null).
 * @param {SessionView} s
 * @returns {{ text: string, title: string } | null}
 */
export function sessionProfile(s) {
  const p = s.profile;
  if (!p) return s.runner ? { text: s.runner, title: 'runner ' + s.runner + ' · from before Agent Profiles' } : null;
  return {
    text: p.model ? p.name + ' (' + p.model + ')' : p.name,
    title: ['runner ' + p.runner, 'effort ' + (p.effort || 'default'), 'permission ' + (p.permission || 'default'), 'args ' + (p.args.length ? p.args.join(' ') : 'none')].join(' · '),
  };
}

/**
 * What one Stage of a Ticket is: done, current, or ahead, with its Sessions (newest first, as the API lists them).
 * @param {MetroTicket} t
 * @param {number} index
 */
export function stageInfo(t, index) {
  const stage = t.stages[index];
  const sessions = (t.sessions || []).filter((s) => s.stage === stage.name);
  const done = t.state === 'done' || index < t.stage.index;
  const cur = t.state === 'active' && index === t.stage.index;
  const rounds = sessions.filter((s) => s.round !== null);
  return {
    stage, done, cur, ahead: !done && !cur, sessions,
    // A terminal Session stays open until the human marks the Stage done; only a headless one is Lasso's work in flight.
    running: sessions.some((s) => s.running && s.mode === 'headless'),
    last: sessions[0] || null,
    attempts: sessions.filter((s) => s.mode !== 'action' && s.round === null),
    roundsUsed: rounds.reduce((max, s) => Math.max(max, s.round), 0),
  };
}

/**
 * The Sessions timeline filtered to one station, or all of them.
 * @param {SessionView[]} sessions
 * @param {string | null} stage
 * @returns {SessionView[]}
 */
export function sessionsForStage(sessions, stage) {
  return stage ? sessions.filter((s) => s.stage === stage) : sessions;
}

/**
 * The one quick action a Ledger row offers: the attention trigger, else Check PR now at a repeating Stage with a PR.
 * @param {TicketView} t
 * @returns {{ action: string, label: string } | null}
 */
export function quickAction(t) {
  const primary = t.triggers.find((x) => x.action === 'retry' || x.action === 'start' || x.action === 'terminal');
  if (primary) return primary;
  if (t.state === 'active' && t.pr && t.stage.repeat) return { action: 'check', label: 'Check PR now' };
  return null;
}

function markers() {
  return '<defs>' + Object.entries(COL).map(([k, v]) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10z" fill="${v}"/></marker>`).join('') + '</defs>';
}

function prIcon(c) {
  return `<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="-6" cy="-6" r="2.6"/><circle cx="-6" cy="6" r="2.6"/><circle cx="6" cy="6" r="2.6"/><path d="M-6 -3.4v6.8M6 3.4V0a4 4 0 0 0-4-4h-3.5"/><path d="M1 -6.5L-1.5 -4L1 -1.5"/></g>`;
}

function octagon(cx, cy, r) {
  const p = [];
  for (let j = 0; j < 8; j++) { const a = Math.PI / 8 + j * Math.PI / 4; p.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1)); }
  return p.join(' ');
}

/**
 * The Ledger's mini track: a station per Stage, action Stages as ticks, the current one ringed in the state's colour.
 * @param {TicketView} t
 * @returns {string}
 */
export function metroTrack(t) {
  let px = 6;
  const pts = t.stages.map((s) => { const p = { s, cx: px }; px += s.kind === 'action' ? 10 : 20; return p; });
  if (!pts.length) return `<svg viewBox="0 0 20 18" data-role="track"></svg>`;
  const ci = t.stage.index;
  const state = STATE_COLOUR[t.display.state] || 'muted';
  let o = `<svg viewBox="0 0 ${px} 18" data-role="track" aria-label="${esc(t.stage.label)}, Stage ${ci + 1} of ${pts.length}"><line x1="${pts[0].cx}" y1="9" x2="${pts[pts.length - 1].cx}" y2="9" stroke="var(--surface2)" stroke-width="3"/>`;
  const reach = t.state === 'done' ? pts.length - 1 : Math.max(0, Math.min(ci, pts.length - 1));
  if (reach > 0) o += `<line x1="${pts[0].cx}" y1="9" x2="${pts[reach].cx}" y2="9" stroke="${t.state === 'abandoned' ? 'var(--line)' : COL.good}" stroke-width="3" opacity=".85"/>`;
  pts.forEach(({ s, cx }, i) => {
    const done = t.state === 'done' || i < ci, cur = t.state === 'active' && i === ci;
    if (s.kind === 'action') { o += `<rect x="${cx - 1}" y="5" width="2" height="8" fill="${done ? COL.good : 'var(--line)'}"/>`; return; }
    const c = done ? COL.good : cur ? COL[state] : 'var(--line)';
    o += cur
      ? `<circle class="current" cx="${cx}" cy="9" r="5" fill="var(--surface)" stroke="${c}" stroke-width="2.5"/><circle cx="${cx}" cy="9" r="2" fill="${c}"/>`
      : `<circle class="${done ? 'done' : 'ahead'}" cx="${cx}" cy="9" r="4" fill="${done ? c : 'var(--surface)'}" stroke="${c}" stroke-width="2"/>`;
  });
  return o + '</svg>';
}

/**
 * The Pipelines list's small line of a Pipeline's Stages: a ring for a Runner or human Stage, a square for an action Stage.
 * @param {Array<{ kind: string }>} stages
 * @returns {string}
 */
export function pipelineLine(stages) {
  let x = 5;
  const pts = stages.map((s) => { const p = { s, x }; x += s.kind === 'action' ? 9 : 14; return p; });
  const w = (pts.length ? pts[pts.length - 1].x : 0) + 5;
  let o = `<svg viewBox="0 0 ${w} 12" width="${w}" height="12" aria-hidden="true"><line x1="5" y1="6" x2="${w - 5}" y2="6" stroke="var(--line)" stroke-width="2"/>`;
  for (const { s, x: cx } of pts) o += s.kind === 'action' ? `<rect x="${cx - 3}" y="3" width="6" height="6" rx="1.5" fill="var(--muted)"/>` : `<circle cx="${cx}" cy="6" r="3.6" fill="var(--bg)" stroke="var(--run)" stroke-width="2"/>`;
  return o + '</svg>';
}

/**
 * The detail's Metro flow diagram: a thick track, station circles for done, current and ahead
 * Stages, action Stages as ticks, a red octagon for Flagged, the PR feedback orbit with its
 * Rounds badge, a small orbit counting attempts, a pulsing ring while running, and no
 * travelling dot. Each station is a node with data-stage, for the timeline filter.
 * @param {MetroTicket} t
 * @param {string | null} focus
 * @returns {string}
 */
export function metroDiagram(t, focus) {
  const baseY = 80;
  let x = 64;
  const pts = t.stages.map((s, i) => { const p = { s, i, cx: x }; x += s.kind === 'action' ? 52 : 104; return p; });
  if (!pts.length) return `<svg viewBox="0 0 100 40" role="img" aria-label="no Stages"><text x="0" y="20" class="sub">This Pipeline does not load.</text></svg>`;
  const W = pts[pts.length - 1].cx + 130, H = 132;
  const ci = t.stage.index;
  const active = t.state === 'active';
  const state = STATE_COLOUR[t.display.state] || 'muted';
  let out = markers();
  out += `<line x1="${pts[0].cx}" y1="${baseY}" x2="${pts[pts.length - 1].cx}" y2="${baseY}" stroke="var(--surface2)" stroke-width="6" stroke-linecap="round"/>`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const k = (i + 1 < ci || t.state === 'done') ? 'good' : (i + 1 === ci && active) ? state : 'muted';
    if (k === 'muted') out += `<line class="segment ahead" x1="${a.cx + 14}" y1="${baseY}" x2="${b.cx - 14}" y2="${baseY}" stroke="var(--line)" stroke-width="6" stroke-linecap="round" stroke-dasharray="1 10"/>`;
    else out += `<line class="segment" x1="${a.cx}" y1="${baseY}" x2="${b.cx}" y2="${baseY}" stroke="${COL[k]}" stroke-width="6" stroke-linecap="round" opacity="${k === 'good' ? '.85' : '1'}"/>`;
  }
  pts.forEach(({ s, i, cx }) => {
    const inf = stageInfo(t, i);
    const sel = focus === s.name;
    const name = esc(s.label);
    if (s.kind === 'action') {
      const c = inf.done ? COL.good : inf.cur ? COL.accent : 'var(--muted)';
      out += `<g class="node action${sel ? ' focus' : ''}" data-stage="${esc(s.name)}"><rect x="${cx - 1.5}" y="${baseY - 9}" width="3" height="18" rx="1.5" fill="${c}"/><text class="act" x="${cx}" y="${baseY + 26}" text-anchor="middle">${name}</text><title>action Stage: ${name}</title></g>`;
      return;
    }
    const c = inf.done ? COL.good : inf.cur ? COL[state] : 'var(--muted)';
    let shape = '';
    if (sel) shape += `<circle class="focus-ring" cx="${cx}" cy="${baseY}" r="18" fill="none" stroke="${COL.accent}" stroke-width="2" stroke-dasharray="3 3"/>`;
    if (inf.cur && t.flag) shape += `<polygon class="flagged" points="${octagon(cx, baseY, 13)}" fill="${COL.crit}" stroke="var(--surface)" stroke-width="2"/><text x="${cx}" y="${baseY + 4.5}" text-anchor="middle" class="bang">!</text>`;
    else if (inf.done) shape += `<circle class="done" cx="${cx}" cy="${baseY}" r="11" fill="${COL.good}" stroke="var(--surface)" stroke-width="2"/><path d="M${cx - 5} ${baseY} l3.5 3.5 l6.5 -7" fill="none" stroke="var(--surface)" stroke-width="2.2"/>`;
    else if (inf.cur) shape += `<circle class="current${inf.running ? ' pulse' : ''}" cx="${cx}" cy="${baseY}" r="11" fill="var(--surface)" stroke="${c}" stroke-width="3.5"/><circle cx="${cx}" cy="${baseY}" r="4.5" fill="${c}"/>`;
    else shape += `<circle class="ahead" cx="${cx}" cy="${baseY}" r="9" fill="var(--surface)" stroke="var(--line)" stroke-width="3"/>`;
    const cls = inf.done ? 'done' : inf.cur ? 'current' : 'ahead';
    out += `<g class="node ${cls}${sel ? ' focus' : ''}" data-stage="${esc(s.name)}">${shape}<text x="${cx}" y="${baseY + 30}" text-anchor="middle" class="name${inf.cur ? ' cur' : ''}${inf.ahead ? ' dim' : ''}">${name}</text>`;
    if (inf.roundsUsed) {
      // The PR feedback orbit: Rounds of a repeating Stage, with Rounds used of the Budget on its badge.
      const lk = inf.running ? 'run' : (inf.cur && t.flag) ? 'crit' : 'good';
      const oc = COL[lk], oy = baseY - 31;
      out += `<path class="orbit rounds" d="M${cx + 8} ${baseY - 8} A24 24 0 1 0 ${cx - 8} ${baseY - 8}" fill="none" stroke="${oc}" stroke-width="2.5" marker-end="url(#arr-${lk})"/>`
        + `<g transform="translate(${cx},${oy})">${prIcon(oc)}<title>PR feedback drives Rounds of ${name}</title></g>`
        + `<g class="badge" transform="translate(${cx + 30},${oy})"><rect x="0" y="-9" width="84" height="18" rx="9" fill="${oc}"/><text x="42" y="4" text-anchor="middle" class="badge-text">${inf.roundsUsed} of ${t.budget.rounds.limit} Rounds</text><title>Rounds used of Budget</title></g>`
        + `<text class="sub" x="${cx}" y="${baseY + 43}" text-anchor="middle">${inf.running ? `Round ${inf.roundsUsed} running` : `${inf.roundsUsed} Round${inf.roundsUsed === 1 ? '' : 's'}`}</text>`;
    } else if (inf.attempts.length > 1) {
      const lk = inf.running ? 'run' : OUTCOME_COLOUR[inf.last.outcome] || 'warn';
      const oc = COL[lk];
      out += `<path class="orbit attempts" d="M${cx + 7} ${baseY - 9} A14 14 0 1 0 ${cx - 7} ${baseY - 9}" fill="none" stroke="${oc}" stroke-width="2.5" marker-end="url(#arr-${lk})"/><text x="${cx}" y="${baseY - 17}" text-anchor="middle" class="count" style="fill:${oc}">${inf.attempts.length}</text>`
        + `<text class="sub" x="${cx}" y="${baseY + 43}" text-anchor="middle">${inf.attempts.length} of ${t.budget.attempts.limit} attempts</text>`;
    } else if (inf.last) {
      const cost = inf.last.costUsd === null ? '' : ' · $' + inf.last.costUsd.toFixed(2);
      out += `<text class="sub" x="${cx}" y="${baseY - 20}" text-anchor="middle">${inf.running ? 'running' : duration(inf.last.durationMs)}${cost}</text>`;
    } else if (inf.cur) {
      out += `<text class="sub" x="${cx}" y="${baseY - 20}" text-anchor="middle">${esc(t.display.label.toLowerCase())}</text>`;
    }
    out += '</g>';
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Stage flow for ${esc(t.reference || t.shortId)}">${out}</svg>`;
}

// Agent Profiles (ADR 0011): what the Config list and the profile drawer say about a profile, from
// config as /api/config returns it and the Pipelines as /api/pipelines lists them (LASSO-72).

/** @typedef {import('../server/config.ts').ProfileConfig} ProfileConfig */
/** @typedef {import('../api/views.ts').PipelineListing} PipelineListing */

/** The model aliases the drawer suggests per Runner; any other text is passed on as written. */
export const MODEL_SUGGESTIONS = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5'],
  pi: ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'],
};

/** The permission each Runner's adapter starts a mode with when the profile sets none (null: no permission layer). */
const BASELINE_PERMISSION = { claude: { headless: 'auto', human: 'edits' }, codex: { headless: 'edits', human: 'edits' }, pi: { headless: null, human: null } };

/**
 * Whether a field does anything on a Runner: Pi has no permission layer, and only Codex reads skills_dir.
 * @param {string} runner
 * @param {string} field
 */
export function profileApplies(runner, field) {
  if (field === 'permission') return runner !== 'pi';
  if (field === 'skills_dir') return runner === 'codex';
  return true;
}

/**
 * A profile with one mode's block merged in, as a Session of that mode runs it: the block's model, effort and
 * permission replace the shared ones, and its args follow. `baseline` marks a permission the adapter supplies.
 * @param {ProfileConfig} p
 * @param {'headless' | 'human'} mode
 */
export function profileMode(p, mode) {
  const block = p[mode] || {};
  const set = block.permission || p.permission || null;
  const permission = !profileApplies(p.runner, 'permission') ? null : set || BASELINE_PERMISSION[p.runner]?.[mode] || null;
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
function modeParts(p, mode) {
  const s = profileMode(p, mode);
  return [
    s.runner,
    s.model || 'model default',
    'effort ' + (s.effort || 'default'),
    !profileApplies(s.runner, 'permission') ? 'permission n/a' : s.permission + (s.baseline ? ' (default)' : ''),
    s.args.join(' '),
  ];
}

/**
 * One mode's resolved settings on a line: runner · model · effort · permission · args.
 * @param {ProfileConfig} p
 * @param {'headless' | 'human'} mode
 */
export function profileLine(p, mode) {
  return modeParts(p, mode).filter(Boolean).join(' · ');
}

/**
 * The Config list's summary: the headless line, then what a human Session runs differently, if anything.
 * @param {ProfileConfig} p
 */
export function profileSummary(p) {
  const headless = modeParts(p, 'headless');
  const human = modeParts(p, 'human');
  const differs = human.filter((part, i) => part !== headless[i]).map((part) => part || 'no args');
  return profileLine(p, 'headless') + (differs.length ? '; human: ' + differs.join(' · ') : '');
}

/**
 * The Runner Stages that run under a profile: those naming it, and those inheriting it from their Pipeline's
 * profile or from config's default_profile. A Pipeline that does not load lists no Stages.
 * @param {string} name
 * @param {PipelineListing[]} pipelines
 * @param {string | null} defaultProfile
 * @returns {Array<{ pipeline: string, stage: string, inherited: boolean }>}
 */
export function profileUsers(name, pipelines, defaultProfile) {
  const users = [];
  for (const p of pipelines) {
    for (const s of p.stages) {
      if (s.kind !== 'runner') continue;
      const resolved = s.profile || p.profile || defaultProfile;
      if (resolved === name) users.push({ pipeline: p.name, stage: s.name, inherited: !s.profile });
    }
  }
  return users;
}

/**
 * The used-by line, a phrase that reads alone: "used by" the Stages naming the profile, then "inherited by" those
 * that inherit it, or "used by no Stages".
 * @param {Array<{ pipeline: string, stage: string, inherited: boolean }>} users
 */
export function usedByLine(users) {
  if (!users.length) return 'used by no Stages';
  const list = (xs) => xs.map((u) => u.pipeline + '/' + u.stage).join(', ');
  const named = users.filter((u) => !u.inherited);
  const inherited = users.filter((u) => u.inherited);
  return [named.length ? 'used by ' + list(named) : '', inherited.length ? 'inherited by ' + list(inherited) : ''].filter(Boolean).join(' · ');
}

/** Pairs a Runner accepts but does not honour, checked per mode (ADR 0011 keeps a short list, no capability table). */
const BAD_PAIRS = [
  { applies: (s) => s.runner === 'claude' && /haiku/i.test(s.model || '') && s.permission === 'auto', text: 'Claude runs Haiku in Manual mode, not auto' },
];

/**
 * The known-bad-pair warnings for a profile, each naming the modes it hits; an unset permission counts as
 * the adapter's default for that mode, so Haiku warns for headless Sessions even with permission unset.
 * @param {ProfileConfig} p
 * @returns {string[]}
 */
export function profileWarnings(p) {
  return BAD_PAIRS.flatMap((pair) => {
    const modes = ['headless', 'human'].filter((mode) => pair.applies(profileMode(p, mode)));
    return modes.length ? [pair.text + ' (' + modes.join(' and ') + ' Sessions)'] : [];
  });
}

/**
 * What a Runner Stage's profile button says (LASSO-73): the profile it runs, "inherit → " when it names none and
 * takes its Pipeline's or config's default_profile, and each mode's resolved line. A name config lacks says so.
 * The Pipeline editor has no repo, so this resolves against the global profiles and default_profile only.
 * @param {string | null} stageProfile the profile the Stage names, or null to inherit
 * @param {string | null} pipelineProfile the profile the Pipeline names, or null
 * @param {{ profiles: Record<string, ProfileConfig>, default_profile: string | null }} config
 * @returns {{ name: string | null, inherited: boolean, label: string, headless: string, human: string }}
 */
export function stageProfileView(stageProfile, pipelineProfile, config) {
  const name = stageProfile || pipelineProfile || config.default_profile || null;
  const inherited = !stageProfile;
  const label = (inherited ? 'inherit → ' : '') + (name || 'none');
  const p = name ? config.profiles[name] : undefined;
  const missing = name ? 'no profile named ' + name + ' in config.yaml' : 'no profile: config.yaml sets no default_profile';
  return { name, inherited, label, headless: p ? profileLine(p, 'headless') : missing, human: p ? profileLine(p, 'human') : missing };
}

/** @typedef {import('../api/views.ts').StageProfileView} StageProfileView */

/**
 * What a Runner Stage's profile button says on the Ticket page (LASSO-75): the profile its next Session runs, marked
 * "overridden" while a human's override stands, and each mode's resolved line; a profile that does not resolve says why.
 * @param {StageProfileView} v from the Ticket detail
 * @returns {{ name: string | null, overridden: boolean, label: string, headless: string, human: string }}
 */
export function ticketProfileView(v) {
  return {
    name: v.profile,
    overridden: v.overridden,
    label: v.profile || 'none',
    headless: v.headless ? profileLine(v.headless, 'headless') : v.problem || '',
    human: v.human ? profileLine(v.human, 'human') : v.problem || '',
  };
}

/**
 * A Ledger row's stage text: the Stage and its place, then the profile with a star only when a human overrode the
 * current Stage's profile, e.g. "plan · 3/8 · claude-fable*". Nothing extra otherwise (LASSO-63).
 * @param {TicketView} t
 */
export function ledgerStageText(t) {
  const place = t.stage.index < 0 ? '' : ' · ' + (t.stage.index + 1) + '/' + t.stages.length;
  return t.stage.label + place + (t.stage.override ? ' · ' + t.stage.override + '*' : '');
}

// Repo overrides (LASSO-74): a repo may define its own profile of a global's name, which replaces it whole for that
// repo's Tickets, or one no global has. The Config list and the drawer show both, and the drawer has a tab per scope.

/** @typedef {{ profiles: Record<string, ProfileConfig>, default_profile: string | null, repos: Record<string, { profiles: Record<string, ProfileConfig>, default_profile: string | null }> }} ProfilesConfig */
/** @typedef {{ name: string, global: boolean, repos: string[] }} ProfileEntry */

/**
 * Every profile config defines, once each: the global ones in config's order, then those only some repo has,
 * each with the repos that define their own of that name.
 * @param {ProfilesConfig} config
 * @returns {ProfileEntry[]}
 */
export function profileIndex(config) {
  const repos = Object.entries(config.repos || {});
  const reposWith = (name) => repos.filter(([, r]) => r.profiles && r.profiles[name]).map(([repo]) => repo);
  const global = Object.keys(config.profiles).map((name) => ({ name, global: true, repos: reposWith(name) }));
  const only = [...new Set(repos.flatMap(([, r]) => Object.keys(r.profiles || {})))].filter((name) => !config.profiles[name]);
  return [...global, ...only.map((name) => ({ name, global: false, repos: reposWith(name) }))];
}

/**
 * What a profile's line says about its scopes: "overridden in app, web" for a global with repo overrides,
 * "only in app" for one no global has, and nothing for a plain global profile.
 * @param {ProfileEntry} entry
 */
export function scopeNote(entry) {
  if (!entry.repos.length) return '';
  return (entry.global ? 'overridden in ' : 'only in ') + entry.repos.join(', ');
}

/**
 * The drawer's scope tabs for a profile: "global" when config.yaml defines it there, then each repo with its own.
 * @param {ProfileEntry} entry
 * @returns {Array<{ repo: string | null, label: string }>}
 */
export function profileScopes(entry) {
  return [...(entry.global ? [{ repo: null, label: 'global' }] : []), ...entry.repos.map((repo) => ({ repo, label: repo }))];
}

/**
 * The repos "Override for repo…" offers: those configured without their own profile of this name. Only a global
 * profile can be copied into a repo, so a repo-only one offers none.
 * @param {ProfileEntry} entry
 * @param {ProfilesConfig} config
 */
export function overridableRepos(entry, config) {
  return entry.global ? Object.keys(config.repos || {}).filter((repo) => !entry.repos.includes(repo)) : [];
}

/**
 * The profile one scope defines: the global one, or a repo's own.
 * @param {ProfilesConfig} config
 * @param {string} name
 * @param {string | null} repo
 * @returns {ProfileConfig | undefined}
 */
export function scopedProfile(config, name, repo) {
  return repo === null ? config.profiles[name] : config.repos[repo]?.profiles?.[name];
}

/**
 * The route that saves or deletes a profile in one scope.
 * @param {string} name
 * @param {string | null} repo
 */
export function profileRoute(name, repo) {
  const scope = repo === null ? '/api' : '/api/repos/' + encodeURIComponent(repo);
  return scope + '/profiles/' + encodeURIComponent(name);
}
