# Lasso

Lasso drives a Ticket through a Pipeline of Stages using a coding-agent Runner
(Claude Code, Codex, or Pi), keeps Ticket state in its own store mirrored to the
tracker, and shows every Ticket on a local dashboard. The spec is
`docs/spec/lasso-v1.md`; the glossary is `CONTEXT.md`; decisions are in `docs/adr`.

## Run

Node 24 or later (the code runs as TypeScript directly; nothing is compiled).

```sh
pnpm install
pnpm start            # starts lasso on http://localhost:7433
pnpm start -- status  # the ledger, as a client of the running process
```

Everything Lasso owns lives under `~/.lasso` (`LASSO_HOME` overrides it):
`config.yaml`, `pipelines/`, `tickets/`, `lasso.db`, `lasso.log`, `lasso.pid`.
The first run writes a commented `config.yaml` and the default Pipeline and
never touches either again.

A Pipeline names a Runner per Stage (`runner: claude | codex | pi`); a
Stage may also carry `runnerOptions`, which Lasso does not model beyond
passing through: `args` (extra argv before the prompt) and, for Codex,
`skillsDir` (where its skill catalog lives, default `~/.agents/skills`).
Codex ignores a skill mention whose path is outside its catalog without
a word, so set `skillsDir` when the skills live elsewhere.

## Test

```sh
pnpm typecheck
pnpm test
```

Tests drive the localhost JSON API end to end against a temporary Lasso home,
with fake executables on `PATH` standing in for anything outside the process:
the notifier, and `gh` and `acli` shims that answer from canned replies a test
seeds and record every invocation for it to assert on (the fake Runner arrives
with the slice that needs it). See `test/harness.ts`.

Reference intake talks to the tracker through those same CLIs: `acli jira
workitem view` and a JQL search per transition status for JIRA, `gh issue view`
for GitHub. Both must be installed and authenticated for reference Tickets.
