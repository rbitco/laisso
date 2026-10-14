# Lasso

Lasso drives a Ticket through a sequence of Stages, some run by agents and some
by a human, and gives that human an at-a-glance view plus levers to trigger the
next step or intervene.

## Language

**Ticket**:
A single unit of work Lasso drives from idea to merged. Once a tracker issue
exists for it, the Ticket is linked to that issue; a Ticket that began as a
prompt has none until Grill publishes a spec.
_Avoid_: issue, work item, task, card

**Intake**:
The act of turning a tracker reference or a prompt into a Ticket bound to a
repo, a Pipeline, and a branch in its own worktree.
_Avoid_: import, add, create ticket, onboard

**Stage**:
One named step in a Ticket's journey, defined by its Pipeline: either a
prompt run by a Runner, with or without a human present, or an Action Lasso
runs itself, such as moving the tracker issue to a status. The default
Pipeline's Stages are Grill, Plan, Implement, Document, Review, but a
Pipeline may name any ordered list of Stages.
_Avoid_: step, phase, state, node

**Action**:
A named shell command, defined in Lasso's config globally or per repo, that
an action Stage runs by name with the params the Stage supplies. It succeeds
or fails by its exit code.
_Avoid_: hook, script, built-in, task

**Budget**:
The limits on how much effort a Ticket may consume before it is Flagged:
Rounds per repeating Stage, attempts per Stage, wall time per Session, and
agent spend per Ticket. Set globally, per Pipeline, or per Ticket, with the
most specific value winning.
_Avoid_: guardrail, boundary, limit, quota

**Flagged**:
A Ticket that has exhausted its Budget or otherwise needs a human before any
agent may continue. It carries the reason, starts no new Session, and clears
only when a human retries, resumes, extends, takes over, marks done, skips,
or abandons.
_Avoid_: blocked, stuck, escalated

**Attention**:
The condition of a Ticket that is waiting on a human: Flagged, running a
human-in-the-loop Stage, or holding at a Stage that does not auto-advance.
The dashboard lists these first and Lasso notifies once as each begins.
_Avoid_: pending, waiting, needs review, action required

**Queued**:
A Ticket whose next Stage could run now but for the concurrency cap: every
slot is held by a running headless Session. Queued Tickets start oldest
first as slots free. Only running headless Sessions hold a slot, so a
Flagged Ticket or a human Stage never keeps the line from moving.
_Avoid_: pending, waiting, blocked, backlogged

**Ledger**:
The dashboard's list of active Tickets, ordered so that whatever needs
Attention comes first. Done and Abandoned Tickets sit behind a toggle.

**Abandoned**:
A Ticket a human has dropped before its Pipeline finished. It leaves Lasso's
attention without counting as done and cannot be reopened; the same issue
can be intaken again as a new Ticket.
_Avoid_: cancelled, closed, dropped, deleted, paused

**Pipeline**:
The ordered list of Stages a Ticket follows, with each Stage's prompt. A
prompt may be no more than a skill call. A Ticket follows exactly one
Version of one Pipeline.
_Avoid_: workflow, playbook, template, orchestration

**Version**:
A frozen copy of a Pipeline, numbered v1, v2, and so on, taken the first
time Intake binds a Ticket to content that differs from the last Version.
A Ticket keeps its Version until a human upgrades it, so editing or
deleting a Pipeline never changes a Ticket already under way. Only the
current Pipeline is offered at Intake.
_Avoid_: revision, snapshot, release, disabled

**Artifact**:
What a Stage must have produced for Lasso to count it done, named from a
fixed catalogue such as a spec on the tracker, commits on the branch, an
open PR, or a merged PR. Checked after a Runner succeeds, and with
warn-and-override when a human marks a Stage done.
_Avoid_: output, deliverable, result, check

**Runner**:
The CLI agent that executes one Stage for one Ticket: Claude Code, Codex, or
Pi. A Stage reaches its Runner through an Agent Profile.
_Avoid_: LLM, model, agent, executor, harness

**Agent Profile**:
A named choice of Runner, model, effort, and permission, with extra
arguments, that a Stage runs under. It may set different values for
headless and human-in-the-loop Sessions. Defined in Lasso's config
globally or per repo; a Stage names one, or inherits its Pipeline's or the
config's default, and a human may override it for one Stage of a Ticket.
_Avoid_: preset, rig, agent, model config

**Session**:
One Runner process working one Stage of one Ticket, identified by the
Runner's own session id. Its name is a label for humans, never an identity.
_Avoid_: run, job, terminal, conversation

**Outcome**:
What a Session reports when it ends: succeeded, failed, exhausted (the
Runner stopped at one of its own limits), or interrupted (the process was
killed or crashed), with the Runner's final message. Lasso, not the Runner,
decides from an Outcome whether the Ticket is Flagged.
_Avoid_: result, exit code, status, verdict

**Feedback**:
Anything on a Ticket's PR that asks for a change: a failed check, an
inline review thread, a top-level comment, or a changes-requested verdict.
Comments the Runner itself posted are not Feedback. Comments on the Ticket
in the tracker are not Feedback either.
_Avoid_: review, comment, issue, finding

**Round**:
One Session of a repeating Stage that addresses the Feedback outstanding
when it started. Feedback arriving mid-Round waits for the next Round.
A retried Round re-runs with the same Feedback and keeps its number.
_Avoid_: iteration, pass, loop, cycle, revision

**Marker**:
The hidden line a Runner ends each PR comment with, naming the Ticket,
Stage, and Round. It is how Lasso tells the Runner's replies from Feedback.
_Avoid_: signature, tag, stamp

**Quiet**:
The displayed state of a Ticket on a repeating Stage with nothing to
address: no PR yet, checks running, or checks green with nothing
outstanding. Lasso keeps polling the PR; a human merges it.
_Avoid_: idle, waiting, blocked

**Tick**:
One pass of Lasso's single clock, in which it polls PRs, retries pending
tracker updates, and starts Queued Sessions. A Tick runs on an interval, on
Check now, and when a Session ends; one already under way is joined, never
doubled.
_Avoid_: poll, refresh, sync, heartbeat
