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
The act of turning a tracker reference, a prompt, or a Runner session named
"Lasso: intake" into a Ticket bound to a repo and a Pipeline.
_Avoid_: import, add, create ticket, onboard

**Stage**:
One named step in a Ticket's journey, defined by its Pipeline: either a
prompt run by a Runner, with or without a human present, or an action Lasso
performs itself, such as moving the tracker issue to a status. The default
Pipeline's Stages are Grill, Plan, Implement, Document, Review, but a
Pipeline may name any ordered list of Stages.
_Avoid_: step, phase, state, node

**Budget**:
The limits on how much effort a Ticket may consume before it is Flagged:
Rounds per repeating Stage, attempts per Stage, wall time per Session, and
agent spend per Ticket. Set globally, per Pipeline, or per Ticket, with the
most specific value winning.
_Avoid_: guardrail, boundary, limit, quota

**Flagged**:
A Ticket that has exhausted its Budget or otherwise needs a human before any
agent may continue. It carries the reason, starts no new Session, and clears
only when a human retries, resumes, extends, marks done, skips, or abandons.
_Avoid_: blocked, stuck, escalated

**Abandoned**:
A Ticket a human has dropped before its Pipeline finished. It leaves Lasso's
attention without counting as done.
_Avoid_: cancelled, closed, dropped, deleted

**Pipeline**:
The ordered list of Stages a Ticket follows, with each Stage's prompt. A
prompt may be no more than a skill call. A Ticket follows exactly one Pipeline.
_Avoid_: workflow, playbook, template, orchestration

**Artifact**:
What a Stage must have produced for Lasso to count it done, named from a
fixed catalogue such as a spec on the tracker, commits on the branch, an
open PR, or a merged PR. Checked after a Runner succeeds, and with
warn-and-override when a human marks a Stage done.
_Avoid_: output, deliverable, result, check

**Runner**:
The CLI agent that executes one Stage for one Ticket: Claude Code, Codex, or
Pi. A Pipeline names a Runner per Stage.
_Avoid_: LLM, model, agent, executor

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
_Avoid_: iteration, pass, loop, cycle, revision
