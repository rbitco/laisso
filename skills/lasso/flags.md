# Why a Ticket is Flagged

A Flagged Ticket starts no new Session until a human clears it. Find the
reason with `lasso status <ticket>` (the reference such as `SHOP-12`, or the
Ticket id; needs Lasso running): its `flag:` line is `<reason>: <detail>`,
and `stdout:` / `transcript:` point at the last Session's output. Lasso's
own log is `<Lasso home>/lasso.log` (one JSON line per event, e.g.
`ticket.flagged`, `session.ended`).

| Reason | What happened | Usual fix |
| --- | --- | --- |
| `outcome.failed` | the Runner reported failure, or an Action exited non-zero, timed out, or could not start (detail is the last output line) | read stdout; for an Action, run its `run` by hand in the worktree with the `LASSO_*` variables set |
| `outcome.exhausted` / `outcome.interrupted` | the Runner hit its own limit, or the process died; retried while attempts remain | raise `attempts` or `wallTime`, then Retry or Resume |
| `budget.wall_time` | a headless Session ran past `wallTime` | raise the Stage's `budget.wallTime`, or Extend |
| `budget.attempts` / `budget.rounds` / `budget.cost` | the Ticket used up its attempts, Rounds, or `spend` | Extend, or raise the Budget in the Pipeline or config.yaml |
| `budget.routes` | an Action picked a Route already taken as many times as its limit allows; the Ticket stays at that Stage and the detail names the Route | Extend with a higher `routes` limit, which then takes the Route; or Mark done or Skip to walk forward instead, or Retry the Stage |
| `artifact.missing` | the Session succeeded but the Stage's artifact is not there | check the prompt produces it; `tracker-spec` and `tracker-comment` always land here (see [pipelines.md](pipelines.md#artifacts)) |
| `artifact.error` | the Stage's [check Action](pipelines.md#check-actions) broke: it exited other than 0 or 1, timed out, or could not start (an Action missing for the repo, a param not supplied, the worktree gone) | run the Action's `run` by hand in the worktree with the `LASSO_*` variables set; fix it, then Retry, or Mark done |
| `route.conflict` | the Stage's agent and its check Action picked different [Routes](pipelines.md#routes); the detail names both picks | decide which way the Ticket goes: Mark done to walk forward, or Retry, Skip, or Abandon |
| `profile.missing` | the profile the Stage resolves to is not in config.yaml for this repo | define it, or point the Stage at one that exists |
| `runner.unavailable` | the Runner could not start, often not on PATH | install it; `lasso doctor` names what is missing |
| `pipeline.missing` | the Ticket's Pipeline cannot be loaded: its pinned Version is gone from the store, or a Ticket from before Versions has lost its Pipeline file or Stage | restore the Pipeline file for an unpinned Ticket; otherwise Skip or Abandon |
| `review.unaddressed` | a Round ended with Feedback still standing | read the detail; Retry, or address it by hand |
| `review.check_repeat` | the same check failed two Rounds running | fix the check by hand, then Retry |
| `review.pr_closed` | an Owned PR was closed without merging; the detail names it | reopen it and Retry, unlink it (`lasso pr unlink`, see [prs.md](prs.md)) and Retry, or Abandon |
| `review.poll_failed` | the PR could not be read (`gh` down, rate limited, logged out) | `gh auth status`, then Retry |

A Flagged GitHub Ticket at a `tracker.transition` Stage with a status other
than `open` or `closed` is a Pipeline mistake, not a tracker one: see
[config.md](config.md#trackertransition).

The exits, in the dashboard and the API: **Retry** (a fresh Session of the
current Stage), **Resume** (re-enter the held Session where the Runner
allows), **Extend** (raise the Ticket's own Budget; on a `budget.routes` Flag, raising
`routes` far enough also takes the Route that was picked), **Mark done** (accept
and advance), **Skip** (drop the Stage and advance; also offered on a Stage that has not started, see [pipelines.md](pipelines.md#runner-stage)), **Take over in
terminal** (re-enter the Session in a terminal and work the Stage as a human
Stage, until Hand back returns it to Lasso), **Send to Stage** (move the
Ticket to any Stage with optional instructions; see
[pipelines.md](pipelines.md#send-to-stage)), **Abandon** (final; the Ticket cannot be reopened, though its issue
can be intaken again; the branch is kept, and the dashboard asks which open Owned PRs to close, all ticked by default). Retry and Resume count against attempts. Fixing config.yaml or a Pipeline does not
clear the Flag on its own; a human still picks an exit.
