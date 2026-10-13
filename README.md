# Lasso

Lasso drives a Ticket through a Pipeline of Stages using a coding-agent Runner
(Claude Code, Codex, or Pi), keeps Ticket state in its own store mirrored to the
tracker, and shows every Ticket on a local dashboard. The spec is
`docs/spec/lasso-v1.md`; the glossary is `CONTEXT.md`; decisions are in `docs/adr`.

## Run

Node 24 or later. The server runs as TypeScript directly; only the
dashboard is built, by Vite, into `dist/dashboard/` (ADR 0012). Lasso
refuses to start until it is built.

```sh
pnpm install
pnpm start            # builds the dashboard, then starts lasso on http://localhost:7433
pnpm start -- status  # the ledger, as a client of the running process
pnpm start -- check   # run a tick now and print what changed
pnpm build            # build the dashboard alone
pnpm dev              # serve the dashboard from source, forwarding /api to a running lasso (LASSO_PORT, default 7433)
```

Everything Lasso owns lives under `~/.lasso` (`LASSO_HOME` overrides it):
`config.yaml`, `pipelines/`, `tickets/`, `lasso.db`, `backups/`, `lasso.log`, `lasso.pid`.
The first run writes a commented `config.yaml` and the default Pipeline and
never touches either again. Before an upgrade migrates `lasso.db`, Lasso copies
it to `backups/` (the newest 5 are kept); an older Lasso refuses to open a
`lasso.db` a newer one has migrated.

Stages run under Agent Profiles defined in `config.yaml` (`profiles:`):
each names a `runner` (`claude | codex | pi`) and may set a `model`,
an `effort` (`low | medium | high | xhigh | max`), a `permission`
(`auto | edits | full`; Pi has none and ignores it), extra `args` (argv
before the prompt) and, for Codex, `skills_dir` (where its skill catalog
lives, default `~/.agents/skills`). Unset effort keeps the Runner's
default; unset permission keeps Lasso's per mode (Claude `auto` headless
with prompts off, `acceptEdits` in a terminal; Codex workspace-write). Optional
`headless:` and `human:` blocks set `model`, `effort`, `permission` and
`args` for one mode only: a human Stage's Sessions take `human:`, the rest
`headless:`. A block's fields replace the shared ones and its args follow
the shared args; each Session records the merged result. A Stage
runs its own `profile:`, else its Pipeline's, else its repo's
`default_profile`, else the global one. A repo entry may carry its own
`profiles:`; one named like a global profile replaces it whole for that
repo's Tickets, with no field merge, and one may exist only for that
repo. Intake checks profiles against the chosen repo; saving a Pipeline
accepts a profile any repo has.
Profiles are read when each Session starts, so an edit applies to the
next Session without a restart. Codex ignores a skill mention whose path
is outside its catalog without a word, so set `skills_dir` when the
skills live elsewhere. A Pipeline still using `runner:` or
`runnerOptions` is rewritten to profiles when Lasso starts.

A new install ships `claude-fable`, `claude-opus` and `claude-sonnet`
(Claude with that model alias, `permission: auto`, effort unset), with
`default_profile: claude-opus`, plus commented Codex and Pi examples. The
default Pipeline runs Grill, Plan and Code Review on `claude-fable`,
Document on `claude-sonnet`, and Implement and Review on the default. An
existing install keeps its files; its migration writes runner-only
`claude`, `codex` and `pi` profiles and `default_profile: claude`.

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

A Stage with `repeat: feedback` is the Review loop. Each tick Lasso
polls the Ticket's PR through `gh` (comments, review threads, check
runs on the head commit, the review decision) with ETags, so an
unchanged PR costs nothing against the rate limit. New Feedback opens a
Round: a Session whose prompt carries the snapshot of what to address
and a marker (`<!-- lasso:<ticket>:<stage>:round-<n> -->`) the Runner
ends each of its PR comments with, so its own replies are never taken
for Feedback. When the Round ends Lasso records how each item was
addressed (a resolved thread, a marked reply, a new push) and Flags
`review.unaddressed` for what still stands, `review.check_repeat` when
the same check fails two Rounds running, and `review.pr_closed` when
the PR closes unmerged. A merged PR finishes the Stage; green checks
with nothing outstanding show as quiet. `lasso check` and the header's
Check now run a tick and report what changed. The dot left of Check now
pulses while a Tick runs and turns red while the dashboard can't reach
Lasso; hover it for when the last Tick ran and the next is due.

Ctrl-C stops every running headless Session by process group and
records each as interrupted with reason shutdown before Lasso exits;
terminal Sessions are left alone. On the next start, before the first
tick, any Session row still marked running is reconciled the same way
(a leftover process is killed and waited out first), and the first tick
runs at once, so queued Tickets and interrupted runs and Rounds resume
within seconds. Ctrl-C during that first tick is honoured too. A
Session cut off by shutdown never counts as an attempt, and a Round cut
off is run again against its own attempts, not the previous Round's.

A Ticket's end of life is final (ADR 0007). Done, when the last Stage
completes or Mark done or Skip lands on it, removes the worktree and
the local branch and clears every `lasso:*` label; the tracker's status
stays where the Pipeline left it. Abandon kills the Ticket's headless
Sessions, commits anything uncommitted as `wip: abandoned in Lasso` and
pushes it when the branch has a remote, removes the worktree, keeps the
branch, and closes an open PR with a marked comment. There is no
Reopen: intaking the same issue again makes a new Ticket on the kept
branch. The per-Ticket directory under `~/.lasso/tickets/` outlives
both until the tick sweeps it `retention` days later (default 30);
store rows are never swept. Done and Abandoned Tickets sit greyed
behind the dashboard's "Show done and Abandoned" toggle.

Pipelines and `config.yaml` can be edited from the dashboard (the
Pipelines and Config links in the header) or through `/api/pipelines`
and `/api/config`. Edits change only the fields you touched and keep
the file's comments and ordering; nothing is written that does not
parse. Budget, concurrency, retention, branch prefix and notification
changes apply at once; `port:` and `tick:` apply after a restart, and
`repos:` stays a hand edit, though a config edit from the dashboard
picks up any change to it made since Lasso started.

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
