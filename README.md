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

Every Ticket runs under a Budget: `rounds` (per repeating Stage),
`attempts` (per Stage), `wallTime` (per headless Session) and `spend`
(USD per Ticket). `config.yaml` sets the defaults, a Pipeline may
tighten or loosen them (`budget:` on the Pipeline for `spend`, on a
Stage for the rest), and Extend on a Ticket overrides both. Lasso
retries an interrupted or exhausted Session while attempts remain and
Flags the Ticket when they run out or the spend is used up. A Flagged
Ticket offers six exits in the dashboard and the API: Retry, Resume,
Extend, Mark done, Skip and Abandon.

`concurrency:` in `config.yaml` caps how many headless Sessions run at
once across all Tickets (default 3). Terminal Sessions never hold a
slot. Tickets past the cap queue in the order they became runnable and
show their position in the Ledger; each tick starts the oldest in line
as slots free up. A change to the cap applies on the next tick without
a restart. Retry and Resume, being explicit human acts, start
regardless of the cap.

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
