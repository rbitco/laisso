---
status: accepted
---

# Agent Profiles carry Runner, model, effort, and permission

A Stage could only name a Runner and pass opaque `runnerOptions.args`, so
choosing a model per Stage or running human Sessions in Claude's auto
mode meant hand-writing CLI flags, and ADR 0003 kept permissions out of
Lasso's model. We decided that a Stage runs under a named Agent Profile
defined in `config.yaml`: a Runner plus typed `model`, `effort`, and
`permission`, with `args` kept as an escape hatch. Each adapter maps the
typed fields to its Runner's own flags. Raw args alone were not enough:
Codex rejects a repeated `-m`, `-s`, or `-a` and its adapter already
passes `-s`, so a profile could not override the baseline by appending,
and effort is a flag on Claude and Pi but a config key on Codex
(research on `research/runner-cli-flags`). This amends ADR 0003's
"Lasso does not model permissions" and ADR 0006's Pipeline `runner`.

## Considered Options

- Only `runner` and `model` typed, everything else as args: breaks on
  Codex unless adapters strip baseline flags a profile repeats, and the
  dashboard is left editing raw flags for the common cases.
- Profiles inside each Pipeline, frozen with its Version: duplicates the
  same few profiles across Pipelines, and a bad model choice cannot be
  fixed on live Tickets without an upgrade.

## Consequences

- `permission` is `auto`, `edits`, or `full`. Claude maps them to
  `--permission-mode auto | acceptEdits | bypassPermissions`; Codex to
  `--approve-for-me`, `-s workspace-write`, and
  `--dangerously-bypass-approvals-and-sandbox`. Pi has no permission
  layer, so the field has no effect there. Anything else goes in `args`.
- `effort` is `low`, `medium`, `high`, `xhigh`, or `max`, the set all
  three Runners accept: `--effort`, `-c model_reasoning_effort`, and
  `--thinking`. `model` is free text; a bad id fails the Session.
- A profile may hold `headless:` and `human:` blocks. A block's fields
  replace the shared ones and its args follow the shared args. A field
  unset in both keeps the adapter's existing baseline for that mode.
- A Stage's profile is a human's override for that Stage on the
  Ticket, else the Stage's own `profile:`, else its Pipeline's, else
  `default_profile` in config. An override is kept on the Ticket, by
  Stage name, until cleared; it survives an upgrade only if the Stage
  does. Resume keeps the Session's Runner, so an override naming a
  different Runner needs a retry. A repo's `profiles:` entry replaces a
  global profile of the same name outright, as with Actions.
- Profiles are live config, not part of a Version (ADR 0009): an edit
  reaches the next Session of every Ticket. Each Session records the
  resolved runner, model, effort, permission, and args it ran with.
- Pipeline save and Intake check that each named profile exists for the
  repo; config load checks the runner, effort, and permission values.
  Lasso keeps no model capability table; the dashboard warns on a short
  list of known bad pairs, such as Claude's Haiku with `auto`, which
  Claude silently runs in Manual.
- Pipeline `runner:` and Stage `runner:` and `runnerOptions` are
  removed. Migration writes a runner-only profile named for each Runner
  in use (`claude`, `codex`, `pi`), sets `default_profile: claude` when
  config has none, and rewrites `runner: X` to `profile: X` in Pipeline
  files and pinned Versions; the old fields then fail validation. A
  Stage with `runnerOptions` gets its own profile, `<pipeline>-<stage>`.
  Codex's `skillsDir` becomes an optional profile field `skills_dir`
  that only the Codex adapter reads.
- A profile named by an override, Stage, or Pipeline that is gone from
  config when a live Ticket's Stage next runs Flags the Ticket with
  that reason; nothing falls back to another model silently.
