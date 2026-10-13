# Agent Profiles and Runners

A Runner is the CLI agent that runs a Stage: `claude` (Claude Code), `codex`
or `pi`. A Stage reaches it through an Agent Profile: a named choice of
Runner, model, effort and permission, defined in config.yaml under
`profiles:` (globally) or `repos.<name>.profiles:` (one repo).

## Fields

| Field | Rule |
| --- | --- |
| `runner` | required: `claude`, `codex` or `pi` |
| `model` | non-empty text, passed to the Runner's model flag as written (`--model` for Claude and Pi, `-m` for Codex). Unset keeps the Runner's default. |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`. Claude `--effort`, Codex `-c model_reasoning_effort=<level>`, Pi `--thinking`. Unset keeps the Runner's default. |
| `permission` | `auto`, `edits` or `full`. Unset keeps Lasso's baseline per mode (below). Pi has no permission layer and ignores it. |
| `args` | list of extra arguments, put after every flag Lasso writes |
| `skills_dir` | Codex only: where Stage skills live, default `~/.agents/skills`. Codex silently ignores a skill outside its skill roots, so set this when the skills live elsewhere. Lasso does not expand `~` here: write an absolute path. |
| `headless` / `human` | optional blocks with `model`, `effort`, `permission`, `args` for one mode only |

Any other field, in a profile or a block, is an error. Profile names are
lowercase letters, digits, dots, hyphens and underscores.

How `permission` maps, per Runner:

| permission | Claude `--permission-mode` | Codex |
| --- | --- | --- |
| unset, headless | `auto` (prompts off) | `-a never -s workspace-write` |
| unset, human | `acceptEdits` | `-s workspace-write` |
| `auto` | `auto` | `--approve-for-me` |
| `edits` | `acceptEdits` | `-s workspace-write` |
| `full` | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

Headless Claude Sessions always run with permission prompts off, whatever
the permission, since nobody is there to answer.

## Mode blocks

A human Stage's Sessions use the `human:` block; every other Session uses
`headless:`. A block's `model`, `effort` and `permission` replace the shared
ones; its `args` follow the shared `args`.

```yaml lasso-config
profiles:
  codex-high:
    runner: codex
    model: gpt-5-codex
    effort: high
    permission: auto
    args: [-c, foo=bar]
    human:
      permission: edits
      args: [--search]
  pi-gpt:
    runner: pi
    model: openai/gpt-5
    effort: medium
    human:
      effort: high
default_profile: codex-high
```

## Which profile a Stage runs under

The first that is set: the Ticket's override for that Stage (a human sets
it from the dashboard), the Stage's `profile:`, the Pipeline's `profile:`,
the repo's `default_profile`, config.yaml's `default_profile`. The name is
looked up in the repo's own profiles first, then the global ones. A name
that is not found Flags the Ticket `profile.missing` when the Session would
start; it never falls back to another profile. Intake refuses a Ticket
whose Pipeline has a Stage that resolves to no profile for that repo.

Profiles are read from config.yaml as each Session starts, so an edit
applies to the next Session without a restart.

## Per-repo profiles

A profile under `repos.<name>.profiles:` named like a global one replaces it
**whole** for that repo's Tickets: no field is merged from the global one.
A repo may also have profiles no other repo sees.

```yaml lasso-config
repos:
  web:
    tracker: github
    project: acme/web
    path: ~/code/web
    default_profile: claude-opus
    profiles:
      claude-opus:
        runner: claude
        model: opus
        effort: high
        permission: auto
```

## Shipped profiles

A new install has `claude-fable`, `claude-opus` and `claude-sonnet` (Claude
with that model alias and `permission: auto`) and `default_profile:
claude-opus`. An install from before profiles was migrated to runner-only
`claude`, `codex` and `pi` profiles and `default_profile: claude`. Deleting
`profiles:` entirely brings the three shipped ones back; to have none, write
`profiles: {}`.

`lasso doctor` lists each Runner some profile in use needs and whether it
is on PATH and logged in (Claude only; Codex and Pi have no status check).
