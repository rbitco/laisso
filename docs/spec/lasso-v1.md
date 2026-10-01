# Lasso v1 spec

Assembled from the wayfinder map "Wayfinder map: Lasso v1 spec" (LASSO-1) and its twenty-three resolved tickets, CONTEXT.md, and ADRs 0001 to 0008. Every term capitalised below is defined in CONTEXT.md. Where this spec and a ticket disagree, the ticket's resolution comment wins and this document is wrong.

## Problem Statement

A solo developer working across several repos wants coding agents (Claude Code, Codex, Pi) to carry a piece of work from a rough idea to a merged PR with as little babysitting as possible. Today each step is a hand-driven agent session: grill the idea, write a plan, implement, document, open the PR, then watch the PR and re-run the agent every time CI fails or a reviewer comments. Nothing remembers where each piece of work is, how much agent effort it has consumed, or that a PR has been sitting with unaddressed comments since yesterday. The developer either polls PRs by hand or forgets them, and has no guard against an agent looping on a broken check forever.

## Solution

Lasso is a local, single-user tool. It takes a Ticket (a tracker issue or a bare prompt), binds it to a repo, a Pipeline, and a branch in its own worktree, and drives it Stage by Stage: some Stages run a Runner headlessly, some open a terminal for the human, some are actions Lasso performs itself such as moving the tracker status. A scheduler polls each open PR and launches one fresh Round of the repeating Review Stage whenever new Feedback appears, until a human merges. A Budget bounds Rounds, attempts, wall time, and agent spend; when it is exhausted or something fails, the Ticket is Flagged and the human is notified once. A local web dashboard shows every Ticket at a glance, attention first, with a detail view per Ticket and the levers to start, resume, extend, mark done, skip, or abandon. A small CLI adds Tickets, prints status, and forces a tick. One foreground process does all of this and is the only writer of Lasso's store; the tracker only mirrors.

## User Stories

Intake

1. As a developer, I want to paste a JIRA key or a GitHub issue reference into one input on the dashboard, so that the issue becomes a Ticket without any other form.
2. As a developer, I want to type a bare prompt into the same input, so that an idea with no issue yet can start its Pipeline at Grill.
3. As a developer, I want Lasso to detect whether I pasted a reference or a prompt and show me what it detected, so that a mis-detection is a click to fix rather than a silent mistake.
4. As a developer, I want Lasso to suggest the repo from my config map and ask me to confirm it, so that a Ticket never lands in the wrong checkout.
5. As a developer, I want the repo's default Pipeline suggested with the option to pick another, so that unusual work can use a different Pipeline without editing config.
6. As a developer, I want the issue's title and body pulled into Lasso at intake, so that every Stage prompt can see them without a tracker call.
7. As a developer, I want intake to end with a worktree and branch already created, so that Grill and every later Stage run in the Ticket's own checkout from the first minute.
8. As a developer, I want the branch named from my configured prefix, the tracker key, and a short slug of the title, so that I recognise the branch in git and on GitHub.
9. As a developer, I want a branch that already exists to be checked out rather than refused, so that re-intaking an Abandoned issue or adopting a branch I started by hand just works.
10. As a developer, I want intake to refuse a reference that already has an active Ticket, so that the same issue is never driven twice at once.
11. As a developer, I want `lasso add <reference-or-prompt>` from a shell with the same detection and confirmation as the dashboard, so that I can intake from wherever I am.
12. As a developer, I want `--yes`, `--repo`, and `--pipeline` on `lasso add`, so that a script can intake without prompts when the answer is unambiguous.
13. As a developer, I want `lasso add` to print the new Ticket's id, name, and dashboard URL, so that I can jump straight to it.

Pipelines and Stages

14. As a developer, I want each Pipeline to be one YAML file under my Lasso home that I can edit by hand or from the dashboard, so that a prompt fix is a file edit and my target repos carry no Lasso files.
15. As a developer, I want a Stage to declare its prompt or skills, its Runner, its human-in-the-loop flag, its auto-advance flag, its artifact, and its per-Stage Budget, so that Lasso runs every Stage generically.
16. As a developer, I want an action Stage that moves the tracker status by literal name, so that where "In Progress" and "In Review" happen is my Pipeline's choice.
17. As a developer, I want a bad status name or unknown artifact to fail validation at intake, so that a broken Pipeline never gets a Runner started.
18. As a developer, I want a default Pipeline written on first run and never overwritten, so that upgrades never clobber my edits.
19. As a developer, I want the default Pipeline to be Grill, In Progress, Plan, Implement, Document, Code Review, In Review, Review, Done, so that the tracer bullet works out of the box.
20. As a developer, I want a Stage's declared artifact checked after every successful Session, so that a Stage that "succeeded" without producing its output Flags instead of advancing.
21. As a developer, I want a Pipeline renamed or deleted under a live Ticket to leave the running Stage alone and Flag at the next advance, so that a config edit never kills work in flight.

Runners and Sessions

22. As a developer, I want to name a Runner per Stage (Claude Code, Codex, or Pi), so that I can mix Runners in one Pipeline.
23. As a developer, I want each Runner adapter to be a pure translator that builds the command, parses stdout into an Outcome, and finds a session id, so that adapters are testable without a process.
24. As a developer, I want Lasso to spawn headless Sessions itself, tee their stdout into its store, and kill them at the wall-time limit, so that the Runner's own limits are a hint and Lasso's are the enforcement.
25. As a developer, I want every Stage run to be a fresh Session, so that a retry never inherits a confused transcript.
26. As a developer, I want skills declared by name in the Pipeline and emitted in each Runner's native form, so that a Pipeline stays swappable across Runners.
27. As a developer, I want Ticket context handed to every Session as a prompt preamble and environment variables, so that prompts can refer to the issue, repo, and branch without restating them.
28. As a developer, I want a fixed permission baseline per adapter with an opaque per-Stage escape hatch, so that Lasso never models permissions but I can still pass extra flags.

Human-in-the-loop Stages

29. As a developer, I want a human Stage such as Grill to open a terminal with the Runner already running on the Stage prompt and a Lasso-chosen session id, so that I just start talking.
30. As a developer, I want to mark a human Stage done from the dashboard, so that Lasso never guesses that my conversation is finished.
31. As a developer, I want a warning when I mark done without the expected artifact, with the option to override, so that a missing spec is caught but not enforced.
32. As a developer, I want Open terminal to relaunch the Runner on the held session id when my terminal closed, so that I resume where I left off.
33. As a developer, I want a terminal Session row to end only by my act and never because the process exited, so that a closed window never fabricates an Outcome.

Review loop

34. As a developer, I want Lasso to poll each open PR on one global tick with ETag-cached calls, so that watching ten PRs costs nothing against my rate limit.
35. As a developer, I want a Round launched only when new Feedback exists since the last watermark, so that no Runner ever idles on a PR.
36. As a developer, I want each Round's prompt to carry the Feedback snapshot with ids, kinds, paths, lines, and failed-step log slices, so that the Runner knows exactly what it owes.
37. As a developer, I want every Runner-posted comment to carry a hidden marker naming the Ticket, Stage, and Round, so that the next tick does not mistake the Runner's replies for my reviewer's.
38. As a developer, I want a marked Code Review from an earlier Stage to count as Feedback for Review, so that agent review and human review flow through the same loop.
39. As a developer, I want an item counted addressed only by a marked reply, a resolved thread, or a new push, so that "I looked at it" never closes a thread.
40. As a developer, I want the Ticket Flagged when an item stays unaddressed after a Round, when the same check fails two Rounds running, or when the PR closes unmerged, so that a loop never spins on a stuck check.
41. As a developer, I want merging to remain my act, with green checks and nothing outstanding shown only as a quiet state, so that Lasso never merges for me.
42. As a developer, I want a Check now button and a `lasso check` command that run a tick immediately and report what changed, so that I never wait a minute to see a reviewer's comment picked up.

Budget and Flagging

43. As a developer, I want a Budget with Rounds per repeating Stage, attempts per Stage, wall time per Session, and agent spend per Ticket, so that effort is bounded on every axis that matters.
44. As a developer, I want defaults of 5 Rounds, 2 attempts, 30 minutes, and 25 USD, overridable globally, per Pipeline, and per Ticket with the most specific winning, so that one config line changes the norm and one click changes a Ticket.
45. As a developer, I want auto-retry only on interrupted and exhausted Outcomes, so that a failed run stops and asks me instead of burning another attempt.
46. As a developer, I want a Flagged Ticket to freeze while its PR is still polled, so that the watermark is current when I retry.
47. As a developer, I want a reason code and detail on every Flag, so that the ledger tells me why without opening the Session.
48. As a developer, I want Retry, Resume, Extend, Mark done, Skip, and Abandon as the ways out of a Flag, so that every situation has a lever.
49. As a developer, I want a Session I interrupted by stopping Lasso not to count as an attempt, so that restarting Lasso can never Flag a Ticket on its own.

Concurrency

50. As a developer, I want a global cap on concurrent headless Sessions, default three, so that five PRs getting reviewed at once cannot eat my laptop.
51. As a developer, I want terminal Sessions excluded from the cap, so that a forgotten Grill window never stalls the queue.
52. As a developer, I want queued Tickets started oldest-runnable first and shown with their queue position, so that nothing starves and I can see what is next.

Dashboard

53. As a developer, I want a ledger of active Tickets ordered attention first (Flagged, Needs you, Holding, Ready to start, Running, Queued, Quiet), so that what needs me is at the top.
54. As a developer, I want each row to show the status, reference, repo, title, a one-line why, a mini Stage track, four mini Budget rings, last activity, and one quick action, so that I can act without opening the row.
55. As a developer, I want done and Abandoned Tickets behind a toggle, greyed, so that history is there but out of the way.
56. As a developer, I want a Ticket detail with a Metro-style Stage flow diagram showing done, current, Flagged, and ahead Stages, the Review orbit with Rounds used, and attempt orbits, so that the shape of the journey is visible at once.
57. As a developer, I want a Flag box showing reason, detail, time, the last final message, and the six exits, so that clearing a Flag is one screen.
58. As a developer, I want a dark terminal-style Session pane with live-tailed stdout, the final message, and copyable paths to stdout, worktree, and transcript, so that I can follow a run and jump into its files.
59. As a developer, I want four ring-gauge Budget meters that open an inline Ticket-layer editor when clicked, so that Extend is one click.
60. As a developer, I want a timeline of Sessions newest first including action Stages, so that I can see every step Lasso took.
61. As a developer, I want the intake input and the tick status with Check now in every view's header, so that the two global acts are always at hand.
62. As a developer, I want Stop on a running headless Session and Open terminal on a terminal one, so that I can intervene mid-Session.

Process, CLI, and notifications

63. As a developer, I want `lasso` to be one foreground process that serves the dashboard, ticks, spawns Sessions, notifies, and owns the store, so that I can see it, stop it, and read its output.
64. As a developer, I want a fixed port with a pid lock so that a second `lasso` prints the running URL and exits, so that the dashboard URL is bookmarkable and there is never a second writer.
65. As a developer, I want Ctrl-C to stop headless Sessions cleanly and mark them interrupted with reason shutdown, so that a restart is safe and cheap.
66. As a developer, I want restart to kill leftover headless processes, leave terminal Sessions alone, and tick at once, so that Lasso is consistent within seconds of starting.
67. As a developer, I want `lasso status` to print the ledger, or a Ticket's detail with an argument, with `--all` and `--json`, so that a shell glance or a script gets the same truth as the dashboard.
68. As a developer, I want every CLI command to fail with "lasso is not running" when the server is down, so that I never wonder why nothing happened.
69. As a developer, I want a native desktop notification once when a Ticket is Flagged, a human Stage is ready, or a Stage is waiting on a trigger, so that I hear about attention without the dashboard open.
70. As a developer, I want notifications configurable per event and their failures logged only, so that a broken notifier never blocks a Ticket.
71. As a developer, I want one log line per event on stdout and in a rotated log file, so that I can debug live and after the fact.

Store and mirroring

72. As a developer, I want one SQLite store and a per-Ticket directory under my Lasso home, so that everything about a Ticket shares a prefix and cleanup is one removal.
73. As a developer, I want a `lasso:<stage>` label swapped on every transition and a `lasso:flagged` label toggled, so that the tracker shows where each issue is without opening Lasso.
74. As a developer, I want mirror writes to be write-through with pending retry on the tick, so that a tracker outage never loses a Stage change.
75. As a developer, I want a Ticket identified by a ULID with a nullable tracker reference, so that a prompt Ticket exists before its issue does and a re-intake never collides with its predecessor.

End of life

76. As a developer, I want done to remove the worktree, delete the local branch, and clear labels, so that a merged Ticket leaves nothing behind but history.
77. As a developer, I want Abandon to kill headless Sessions, WIP-commit and push uncommitted work, keep the branch, close the PR with a marked comment, and clear labels, so that dropped work is salvageable and the PR explains itself.
78. As a developer, I want Abandon to be irreversible with re-intake as the way back, so that there is one end-of-life path.
79. As a developer, I want a retention setting to sweep old Ticket directories while store rows stay forever, so that disk is bounded and history is not.

## Implementation Decisions

Process model (ADR 0008)

- One foreground process, started by bare `lasso`, serves the dashboard on localhost, runs the scheduler tick, spawns every headless Session as a child, posts notifications, and is the only process that opens the store. No launchd or systemd integration.
- Default port 7433, overridable by `--port` on server and clients or `port:` in config; the flag wins. A pid file under the Lasso home is held under an exclusive lock; a second `lasso` prints the running URL and pid and exits 1.
- Every other subcommand is a thin client over a localhost JSON HTTP API under `/api`. The dashboard page is a client of the same API and the CLI adds nothing the browser cannot do. The API is localhost-only, unauthenticated, and versioned only by the binary.
- Ctrl-C stops headless Sessions by process group and records each as Outcome interrupted with ended_reason shutdown. On startup, before the first tick, Session rows marked running are reconciled: headless rows with a live pid are killed by process group and recorded the same way; terminal rows are left untouched. The first tick runs at once.
- Logging: one line per event to stdout and appended to a size-rotated log file in the Lasso home. Session transcripts are not in this log.

Lasso home and configuration (ADR 0006)

- Everything lives under `~/.lasso`: the SQLite store, `config.yaml`, `pipelines/<name>.yaml`, `tickets/<ulid>/` with `worktree/` and `sessions/<session-id>.stdout`, the pid file, and the log.
- `config.yaml` holds `repos:` (tracker kind, project key or GitHub repo, local path, default Pipeline), `budget:` global defaults, `tick:` cadence in seconds (default 60), `concurrency:` (default 3), `retention:` days (default 30), `branch_prefix:` (may be empty), `port:`, and a `notifications:` block with `enabled`, `flagged`, `human`, `gate`, all true by default.
- Target repos carry no Lasso files. The dashboard edits config and Pipeline files in place with a comment-preserving YAML parser.

Intake

- One free-text input on the dashboard and `lasso add <reference-or-prompt>` share the same server-side detection: a JIRA key, a GitHub issue URL, or owner/repo#n is a reference; anything else is a prompt. Detection is shown and confirmed, never silently applied.
- Repo suggestion: from the project key or GitHub repo for a reference; for a prompt, the only repo in the map when there is exactly one, otherwise a picker with no preselection. `--yes` accepts a suggestion but never a picker and fails with "repo is ambiguous". Pipeline defaults to the repo's default and may be overridden.
- Minimum payload: repo, Pipeline, and a reference or prompt. A reference Ticket pulls the issue title and body into the store at intake. A prompt Ticket has no tracker issue until Grill publishes one; action Stages on such a Ticket are validated once the issue exists.
- Validation at intake: artifact and action names against the built-in catalogues, and each `tracker.transition` status against the Ticket's tracker (GitHub accepts only open and closed). Any failure refuses intake with the reason.
- Tracker-reference uniqueness applies among active Tickets only.
- Intake ends with the worktree and branch in place: fetch origin, branch from origin's default branch, name `<prefix>/<key>-<slug>` where the key is the JIRA key as-is or `owner-repo-n` for GitHub and the slug is the title lowercased, non-alphanumerics collapsed to single hyphens, cut at 15 characters on a word boundary. A prompt Ticket uses the last 8 characters of its ULID in place of the key and a slug of the prompt, and keeps that name after Grill publishes. If the branch already exists locally or on origin it is checked out instead; the confirmation says so.
- The named-session intake path ("Lasso: intake") is not in v1.

Pipelines and Stages (ADR 0002, ADR 0005, ADR 0006)

- A Pipeline is an ordered list of Stages plus a Pipeline-level `runner` default and `budget: { spend }`. Stage kind is inferred: `prompt` and/or `skills` means Runner-run, `action` means action; both is a validation error.
- Runner-run Stage fields: `name` (unique, becomes the `lasso:<name>` label), `prompt`, `skills`, `runner`, `human` (default false), `advance` (default true), `artifact`, `repeat: feedback` (the only v1 trigger; the artifact is the end condition), `budget: { rounds, attempts, wallTime }`, `runnerOptions` (opaque).
- Action Stage fields: `action: tracker.transition` and `status: <literal>`; no Runner, no flags, always auto-advances, records a Session row with a Lasso-minted id and mode action.
- Artifact catalogue: `tracker-spec` (issue exists and carries a spec body), `tracker-comment` (a comment by this Session exists), `commits-on-branch` (commits beyond the base), `pr-exists` (open PR from the branch), `pr-review` (a Lasso-marked review by this Session on the PR), `pr-merged`, `file <path>` (exists in the worktree). Action catalogue: `tracker.transition` only. Both are Lasso code; a Pipeline cannot add to them.
- Done for a Runner-run Stage is Outcome succeeded plus the declared artifact present; otherwise Flagged. Lasso never infers completion from Stage-specific signals. With `advance: false` the next Stage waits for a dashboard Start trigger.
- The default Pipeline is embedded and written to `pipelines/default.yaml` on first run if absent, never touched again. Its contents, as settled (trimmed to the decision-rich fields):

```yaml
runner: claude
stages:
  - name: grill
    human: true
    advance: false
    skills: [grilling, domain-modeling, to-spec]
    artifact: tracker-spec
  - action: tracker.transition
    status: In Progress
  - name: plan
    skills: [codebase-design]
    artifact: tracker-comment
  - name: implement
    skills: [implement]
    artifact: commits-on-branch
  - name: document
    skills: [domain-modeling]
    artifact: pr-exists
  - name: code-review
    skills: [code-review]
    artifact: pr-review
  - action: tracker.transition
    status: In Review
  - name: review
    repeat: feedback
    artifact: pr-merged
  - action: tracker.transition
    status: Done
```

  The prompt text per Stage is in the resolution of "Default Pipeline contents and v1 artifact and action catalogues" (LASSO-18). Implement commits only; Document pushes and opens the PR; Code Review posts one marked PR review; Review is prompt-only and receives the Feedback snapshot each Round.
- Intake pins each Ticket to a Version of its Pipeline (ADR 0009), so renaming, editing, or deleting the file never reaches a live Ticket. Only a Ticket from before Versions whose file could not be pinned still reads the file, and Flags with a missing-Pipeline reason when it is gone.

Runner adapters (ADR 0003)

- One adapter each for Claude Code, Codex, and Pi, each a pure translator with three side-effect-free operations: `command(request)` returning argv, cwd, env, and optional stdin; `parse(capturedStdout)` returning an Outcome; `findSession({cwd, launchedAfter})` returning a session id or null. No liveness operation.
- Request: Stage prompt, skill names, Ticket context, cwd, mode (headless or terminal), sessionId (Lasso-chosen where the Runner allows, or a held id to resume), best-effort limits (wall time, remaining spend), opaque runnerOptions.
- The adapter prepends native skill invocations (Claude `/name`, Codex link-form `$name` by absolute path, Pi `/skill:name`), renders the Ticket context as a prompt preamble plus `LASSO_*` environment variables (Ticket ULID, reference, repo, branch, Stage name, Session id), and applies its fixed permission baseline (Claude headless in auto mode with prompts off, and acceptEdits in a terminal Session; Codex workspace-write with approvals never; Pi as-is). No system-prompt use, no files written into the worktree.
- Outcome: status succeeded, failed, exhausted, or interrupted; sessionId; final message; usage and cost when reported; the Runner's transcript path (a pointer only); which limits were honoured natively. There is no needs-human status.
- Session id: Claude Code and Pi accept a Lasso-chosen id; Codex's thread id is found after launch via `findSession` on the thread table by cwd and creation time.
- Lasso owns spawning, terminal opening, worktrees (never Runner-native worktree flags), stdout teeing, wall-time kills, and fresh Sessions per Stage run. Lasso never reads Runner transcript files.

Human-in-the-loop Stages

- A dashboard action launches the Runner in a terminal with the Stage prompt, a Lasso-chosen session id, and a human-readable name such as "Lasso: LASSO-42 Grill". Lasso tracks the Session by id only.
- The Stage becomes current and shows Needs you before a terminal is opened; the why line reads "not started" or "terminal opened <time>". The Attention notification fires when the Stage becomes current.
- The human marks the Stage done; the declared artifact is checked with warn-and-override. Skip and Abandon also end it. A terminal Session row never ends from the Runner exiting, has no captured stdout, and gets no parsed Outcome. Open terminal relaunches on the held id (Claude Code and Pi by session id, Codex by thread id) and is what Resume means for a human Stage. Lasso does not check liveness or guard duplicate launches.
- Human Sessions have no wall time and are invisible to spend.

Scheduler and Review loop (ADR 0004)

- One global tick (default 60 s) plus Check now. Each tick, per Ticket in a repeating Stage: fetch issue comments, review comments, check runs on the head SHA (REST, ETag-cached, `since` where supported), and one GraphQL query for review threads and reviewDecision; diff against the Ticket's watermark; launch a Round only when the diff is non-empty. Webhook forwarding may fire an early tick, never a Round. No Runner polls.
- A Round is one fresh Session with the Feedback snapshot rendered into the prompt: ids, kinds (check, thread, comment, verdict), path and line, and failed-step log slices. Feedback arriving mid-Round waits.
- Marker: every Runner-posted comment carries `<!-- lasso:<ulid>:<stage>:round-<n> -->`. The tick excludes only comments posted by the Review Stage's own Rounds; marked comments from any other Stage (Code Review) are Feedback until addressed.
- Addressed: inline thread by a marked reply and resolution; top-level comment by a marked reply; CI failure by a new push; changes-requested by its threads.
- Done for Review is the PR merged by a human. Green checks with nothing outstanding is the displayed state quiet.
- Flag on any unaddressed item after a Round, the same check failing in two consecutive Rounds, or the PR closed unmerged.
- The tick also retries pending mirror writes, sweeps expired Ticket directories, and starts queued Sessions.

Budget and Flagging

- Dimensions: Rounds per repeating Stage, attempts per Stage, wall time per Session, spend per Ticket. Layers: global, Pipeline (Rounds, attempts, wall time per Stage; spend at Pipeline level), Ticket; most specific wins per dimension. Defaults 5, 2, 30 minutes, 25 USD. Counters are derived from Session rows and never reset; Extend raises the ceiling on the Ticket layer.
- Wall time is enforced mid-Session by killing the process (Outcome interrupted, ended_reason wall_time). Rounds, attempts, and spend are checked when the next Session would start. The Runner request carries wall time and remaining spend as best-effort limits so a Runner that can stop cleanly reports exhausted instead.
- Auto-retry only on interrupted and exhausted, once per remaining attempt, with a fresh Session; in a repeating Stage a retry re-runs the same Round with the same snapshot. Failed Outcomes and missing artifacts Flag at once. Sessions with ended_reason shutdown are skipped by the attempts counter.
- On Flag only that Ticket freezes; its PR is still polled; its worktree is untouched. The Ticket carries a reason code (budget.rounds, budget.attempts, budget.wall_time, budget.cost, outcome.failed, outcome.exhausted, outcome.interrupted, artifact.missing, review.unaddressed, review.check_repeat, review.pr_closed, pipeline.missing, runner.unavailable for a Runner that could not start at all: no adapter, or the executable failed to spawn) and a detail string.
- Exits, all dashboard acts that clear the Flag: Retry (fresh Session of the current Stage), Resume (re-enter the held Session where the Runner allows), Extend, Mark done (accept and advance), Skip (drop and advance), Abandon. Retry and Resume count against attempts and are refused at the limit until extended.

Concurrency

- `concurrency:` caps running headless Sessions across all Tickets, default 3; terminal Sessions do not count; a Ticket runs at most one Session at a time. Runnable Tickets beyond free slots are started oldest-runnable first, queued by the moment they became runnable. Queued is a displayed state with a position; slots are held only by running headless Sessions. Lasso does nothing about port, cache, or database contention between worktrees.

Store and mirroring (ADR 0001, ADR 0005)

- One SQLite database; current-state rows, no event log. Ticket: ULID id, repo, nullable unique-when-set tracker reference, origin (tracker or prompt, with prompt text), Pipeline name, current Stage, state (active, done, abandoned), flagged_at, flag reason and detail, unflagged_at, PR reference, branch, worktree path, feedback watermark, mirror pending, created, updated. Session: id (Runner's, or Lasso's for action Stages), Ticket, Stage, ordinal, Stage snapshot as rendered, mode (headless, terminal, action), started_by (auto or human), started, ended, ended_by (outcome or human), ended_reason (null, shutdown, wall_time, abandon, stop), Outcome status and final message, usage and cost, natively honoured limits, stdout path, transcript path. feedback_item: Session, kind, source id, URL, summary, addressed evidence or null. A Round is a Session row plus its feedback items; the Round number is the Session's ordinal within its Stage.
- Pipeline is referenced by name and resolved live at each advance; each Session snapshots its Stage.
- Mirror, automatic: `lasso:<stage>` swapped on each transition, `lasso:flagged` toggled, action Stages get no label, GitHub labels created on first use. Write-through: commit the row, then push; on failure store the wanted state as pending and retry on the tick; hand edits in the tracker are overwritten on reconcile. Status moves happen only through action Stages.

Dashboard (from the prototypes on branch prototype/dashboard, variant D of index.html and design.html)

- Ledger of active Tickets ordered Flagged, Needs you, Holding (a Stage finished with `advance: false`; the why line names the Start trigger), Ready to start, Running, Queued (by position), Quiet, most recent activity within each group; done and Abandoned behind an off-by-default toggle, greyed. Two-line rows: status pill in words, reference over repo, title over the one-line why, a mini Metro track with the Stage name, four mini ring gauges, last activity, one quick action.
- Clicking a row collapses the ledger to a left sidebar and opens the detail: title bar (reference, repo, branch, PR link, status pill, triggers); Metro flow diagram (thick track, station circles, red octagon for Flagged, action Stages as ticks, PR feedback orbit with a "Rounds used of Budget" badge, attempt orbits, pulsing ring while running, no travelling dot, horizontal scroll under about 720 px; clicking a station filters the Sessions list); Flag box when Flagged with reason, detail, time, last final message, and the six exits; dark terminal Session pane with outcome pill, Stage, Round or attempt, mode, start, duration, cost, live-tailed stdout, a green final line, Stop or Open terminal, and copy chips for stdout, worktree, and transcript paths (no file links); four ring-gauge Budget meters coloured at 70 % and 100 % with an asterisk for a Ticket override and an inline editor on click; a Sessions timeline newest first including action Stages.
- Header on every view: the intake input, a Tick dot (still when idle, pulsing while a Tick runs, red while Lasso is unreachable; its tooltip gives "last tick · next in") and Check now.
- Triggers per Ticket: Start <Stage> when waiting on a trigger; Open terminal and Mark <Stage> done for a human Stage; Check PR now on the repeating Stage; Abandon; the six Flag exits when Flagged.

CLI

- `lasso` starts the server. `lasso add`, `lasso status [ticket]` (ledger, or detail with an argument; `--all`), and `lasso check [ticket]` (run a tick, wait, print one line per changed Ticket or "nothing new") are thin API clients; all take `--json`. Flag exits and human-Stage triggers are dashboard-only.

Notifications

- A notifier adapter per OS; v1 ships macOS (terminal-notifier when present, osascript fallback). Events, once each: Ticket Flagged, human Stage became current, Stage finished with `advance: false`. Title is the Ticket name (the reference first when it has one, then the title), body is the event plus reason, click opens the Ticket detail where the adapter supports a URL. Failures are logged only.

End of life (ADR 0007)

- Done (last Stage completes, or Mark done or Skip on it): remove the worktree, delete the local branch, remove every `lasso:*` label, leave tracker status alone, state done. Abandon: kill headless Sessions (interrupted, ended_reason abandon), WIP-commit uncommitted work as "wip: abandoned in Lasso" and push if the branch has a remote, remove the worktree, keep the branch, close an open PR with a marked comment, remove labels, state abandoned. No Reopen; re-intake creates a new Ticket and checks out the kept branch if it exists. The tick sweeps `tickets/<ulid>/` after `retention` days; store rows are never swept.

## Testing Decisions

- A good test drives Lasso through a surface a user or a Runner touches and asserts on what a user or the tracker would see: the API's responses, the rows the store holds, the commands Lasso ran, the files in the worktree, the notification posted. Tests never reach into the scheduler, the store layer, or an adapter's internals.
- Seam one, the localhost JSON API, end to end: each test starts the server against a temporary Lasso home with a real SQLite store and a real temporary git origin, and puts three fakes on PATH: a fake Runner executable that plays a scripted stdout and exit code (with an optional sleep to exercise wall time), a `gh` and `acli` shim that replays canned responses and records every invocation, and a fake notifier that records posts. Time is driven by the check-now endpoint rather than timers. Intake, every Stage kind, the Review loop with Rounds and watermarks, Budget and Flagging, the six exits, concurrency and queueing, mirroring and pending retry, shutdown and restart reconciliation, end of life, and the CLI (as a client of the same server) are all tested here.
- Seam two, the Runner adapters as pure functions: `command`, `parse`, and `findSession` for each of Claude Code, Codex, and Pi against recorded real output captured on the research branches (runner-surfaces, session-discovery, codex-skill-invocation), covering success, failure, exhausted, killed, skill invocation forms, and session id discovery.
- Nothing below the API is tested directly; the dashboard page is exercised only through the API it calls, plus a smoke test that the page loads and renders the ledger from API data.
- Prior art: none in this repo; it has no code yet. The fake-executable-on-PATH pattern and the temp-home pattern are the conventions to establish.

## Out of Scope

- Multi-user use: auth, permissions, shared dashboards.
- Comments on the tracker issue as Review Feedback; only PR-side Feedback counts.
- Cloud Runners (Claude Code web, scheduled routines) so runs survive the laptop closing.
- Named-session intake (a Runner session named "Lasso: intake").
- Linux and Windows notifier adapters (interface reserved).
- Repo-local Pipelines shadowing the global ones (a later one-line extension).
- Per-repo concurrency caps, slot numbers, or port allocation for contending worktrees.
- Flag exits and human-Stage triggers on the CLI.
- Building Lasso is the effort this spec hands off to; it is beyond the map.

## Further Notes

- Implementation language and runtime were never decided on the map. Settle it before slicing; nothing in this spec constrains it beyond needing SQLite, subprocess control by process group, a localhost HTTP server, and a YAML parser that preserves comments.
- Research findings with per-claim sources live on branches research/runner-surfaces, research/session-discovery, research/feedback-signals, and research/codex-skill-invocation. Unverified items are listed at the end of each.
- The dashboard prototypes (index.html for layout, design.html for element treatment, variant D in both) are on branch prototype/dashboard; they are primary sources, not code to promote.
- Known gaps a slicer will meet: the exact Grill prompt's interaction with to-spec on a reference Ticket (update the existing issue rather than create one); how `tracker-spec` decides an issue "carries a spec body"; the GitHub tracker adapter's issue-creation path for prompt Tickets.
