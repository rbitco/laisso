# Agent Profiles

Stages run under Agent Profiles defined in `config.yaml` (`profiles:`).
Each names a `runner` (`claude | codex | pi`) and may set:

- `model`
- `effort`: `low | medium | high | xhigh | max`. Unset keeps the Runner's
  default.
- `permission`: `auto | edits | full`. Pi has none and ignores it. Unset
  keeps Laisso's per mode: Claude `auto` headless with prompts off and
  `acceptEdits` in a terminal; Codex workspace-write.
- `args`: extra argv before the prompt.
- `skills_dir` (Codex only): where its skill catalog lives, default
  `~/.agents/skills`. Codex silently ignores a skill mention whose path is
  outside its catalog, so set this when the skills live elsewhere.

Optional `headless:` and `human:` blocks set `model`, `effort`, `permission`
and `args` for one mode only: a human Stage's Sessions take `human:`, the
rest `headless:`. A block's fields replace the shared ones, and its args
follow the shared args. Each Session records the merged result.

## Which profile a Stage runs

A Stage runs its own `profile:`, else its Pipeline's, else its repo's
`default_profile`, else the global one.

A repo entry may carry its own `profiles:`. One named like a global profile
replaces it whole for that repo's Tickets, with no field merge; one may also
exist only for that repo. Intake checks profiles against the chosen repo;
saving a Pipeline accepts a profile any repo has.

Profiles are read when each Session starts, so an edit applies to the next
Session without a restart. A Pipeline still using the older `runner:` or
`runnerOptions` is rewritten to profiles when Laisso starts.

## Shipped profiles

A new install ships `claude-fable`, `claude-opus` and `claude-sonnet`
(Claude with that model alias, `permission: auto`, effort unset), with
`default_profile: claude-opus`, plus commented Codex and Pi examples. The
default Pipeline names no profile, so every Stage runs on the default;
`laisso setup` can suggest a stronger model for planning and review.

An install from before profiles keeps its files; its migration writes
runner-only `claude`, `codex` and `pi` profiles and `default_profile:
claude`.

The full field reference is in
[skills/laisso/profiles.md](../../skills/laisso/profiles.md).
