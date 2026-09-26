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
One named step in a Ticket's journey, defined by its Pipeline: a prompt, a
Runner, and whether a human must be present. The default Pipeline's Stages
are Grill, Plan, Implement, Document, Review, but a Pipeline may name any
ordered list of Stages.
_Avoid_: step, phase, state

**Budget**:
The limits on how much effort a Ticket may consume before it is flagged for a
human. Dimensions are open (revision rounds, runs, tokens, wall time).
_Avoid_: guardrail, boundary, limit, quota

**Flagged**:
A Ticket that has exhausted its Budget or otherwise needs a human before any
agent may continue.
_Avoid_: blocked, stuck, escalated

**Pipeline**:
The ordered list of Stages a Ticket follows, with each Stage's prompt. A
prompt may be no more than a skill call. A Ticket follows exactly one Pipeline.
_Avoid_: workflow, playbook, template, orchestration

**Runner**:
The CLI agent that executes one Stage for one Ticket: Claude Code, Codex, or
Pi. A Pipeline names a Runner per Stage.
_Avoid_: LLM, model, agent, executor

**Session**:
One Runner process working one Stage of one Ticket, identified by the
Runner's own session id. Its name is a label for humans, never an identity.
_Avoid_: run, job, terminal, conversation
