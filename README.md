# Lasso

Lasso drives a Ticket through a Pipeline of Stages using a coding-agent Runner
(Claude Code, Codex, or Pi), keeps Ticket state in its own store mirrored to the
tracker, and shows every Ticket on a local dashboard. The spec is
`docs/spec/lasso-v1.md`; the glossary is `CONTEXT.md`; decisions are in `docs/adr`.

## New machine

Node 24 or later, on the homelab LAN.

```sh
npm config set @rbitco:registry=https://npm.matty.rocks/
npm i -g @rbitco/lasso
lasso skill install
lasso doctor   # which tools Lasso needs, whether each is found and logged in, and what needs it
```

`lasso skill install` copies the Lasso skill (how to write `config.yaml`
and Pipelines, and why a Ticket is Flagged) into `~/.claude/skills/lasso`,
and `~/.codex/skills/lasso` when `~/.codex` exists, so a coding agent can
set Lasso up from docs matching the installed version; rerun it after an
upgrade, as `lasso doctor` will say.

A machine without homelab DNS (the work VLAN) uses
`http://10.30.0.61:4873/` as the registry instead. Only the `@rbitco`
scope points there; everything else still comes from npmjs.

To upgrade, `npm update -g @rbitco/lasso`, then restart Lasso. The
dashboard and `lasso status` say when a newer version is published, and
when one is installed but not yet running.

To try unreleased work from main, `npm i -g @rbitco/lasso@next`
installs the latest preview (a `vX.Y.Z-next.N` tag); `npm i -g
@rbitco/lasso@latest` goes back to the last release.

Lasso also checks PATH at each start, logs a warning per missing tool,
and lists them in the dashboard header.

## Run

Node 24 or later. From a checkout the server runs as TypeScript directly; only the
dashboard is built, by Vite, into `dist/dashboard/` (ADR 0012). Lasso
refuses to start until it is built.

```sh
pnpm install
pnpm start               # builds the dashboard, then starts lasso on http://localhost:7434
pnpm start status        # the ledger, as a client of the running process
pnpm start check         # run a tick now and print what changed
pnpm start --port 7500   # any lasso command and options follow pnpm start
pnpm build               # build the dashboard alone
pnpm dev                 # serve the dashboard from source, forwarding /api to the dev lasso (port 7434)
```

A clone keeps out of the installed Lasso's way: `pnpm start` and `pnpm dev`
use the Lasso home `~/.lasso-dev` on port 7434, where an installed `lasso`
uses `~/.lasso` on 7433, so both can run at once. Set `LASSO_HOME` or
`LASSO_PORT` to override either, such as `LASSO_HOME=~/.lasso` to point dev
at the real home on purpose. `LASSO_PORT` only sets the port in a new
home's `config.yaml`; an existing one keeps its `port:`. A dev build
(version `0.0.0-dev`) shows a "dev" badge in the dashboard header and
"(dev)" in the tab title, and `lasso status` starts with the version and
Lasso home that answered.

The package `@rbitco/lasso` ships prebuilt JavaScript, since Node will not
run TypeScript from `node_modules`. `npm pack` typechecks, builds the
dashboard, then bundles the CLI and server with esbuild into
`dist/lasso.js` (with a source map, so stack traces show `.ts` lines). The
tarball holds only `dist/` and `skills/`. To check one installs and serves:

```sh
npm pack
node scripts/smoke-test.ts rbitco-lasso-0.0.0-dev.tgz 0.0.0-dev
```

To cut a release, tag main and push the tag:

```sh
git fetch origin
git tag vX.Y.Z origin/main && git push origin vX.Y.Z
```

`.github/workflows/release.yml` then runs on the homelab runner: tests,
sets the version from the tag, packs, smoke-tests the tarball, publishes it
to `npm.matty.rocks` and creates a GitHub Release. package.json stays
`0.0.0-dev` in git.

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

Open terminal on a human Stage runs the Runner in a new terminal named
for the Ticket and Stage. `terminal:` in `config.yaml` says where:
`auto` (the default) opens a herdr tab when Lasso was started inside
herdr, a tmux window when inside tmux, and a Terminal.app window
otherwise; `herdr`, `tmux` or `terminal-app` names one outright. The
window opens beside the `lasso` process, not the browser. Under `auto`
a herdr or tmux that fails falls back to Terminal.app and logs why; a
named one that fails is reported on Open terminal. `lasso doctor` says
which applies.

Take over in terminal steps into any headless Stage, running or Flagged:
Lasso stops the Session (a Flag clears), opens its Runner session in a
terminal, and the Stage is then worked as a human Stage until Mark done,
Skip, Abandon or Hand back. Hand back ends the terminal Session and gives
the Stage back to Lasso without spending an attempt: a Review Stage polls
the PR at once and opens a Round for any Feedback that arrived meanwhile,
and any other Stage starts a headless Session that re-enters the terminal's
Runner session. For an approval step, give the drafting Stage
`advance: false`: while the Ticket holds, Open <Stage> in terminal
re-enters the finished draft without changing anything, and Start releases
the next Stage.

A Ticket may be given a name, in the Import Ticket dialog or later with
Name or Rename on its page. The name then shows in place of its reference
or short id in the dashboard, `lasso status`, notifications and terminal
window names; branches and URLs keep the id, and the tracker never sees it.

Every Ticket runs under a Budget: `rounds` (per repeating Stage),
`attempts` (per Stage), `wallTime` (per headless Session) and `spend`
(USD per Ticket). `config.yaml` sets the defaults, a Pipeline may
tighten or loosen them (`budget:` on the Pipeline for `spend`, on a
Stage for the rest), and Extend on a Ticket overrides both. Lasso
retries an interrupted or exhausted Session while attempts remain and
Flags the Ticket when they run out or the spend is used up. A Flagged
Ticket offers six exits in the dashboard and the API: Retry, Resume,
Extend, Mark done, Skip and Abandon.

Skip also passes over a Stage that has not started yet, such as a
second review you don't need: from a Start gate, or while the Stage is
ready or queued. The Pipeline's hold after that Stage still applies,
and the Ticket page marks the Stage Skipped.

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
for Feedback. To comment on your own PR without starting a Round, list
logins under `review.ignore_authors`, or set `review.ignore_self: true`
to ignore the login `gh` is authenticated as (a repo may set either
under `repos.<name>.review`). Their PR comments, and threads no one
else has joined, are never Feedback; a thread someone else has joined
still is, and its Round reads every comment in it. Failed checks and a
changes-requested verdict count whoever is involved. When the Round ends Lasso records how each item was
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
branch, and closes the open Owned PRs you tick in its popover, each with
a marked comment naming its head branch as kept. Unticked, merged and
Referenced PRs are left alone. There is no
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
