# Lasso

Lasso drives a Ticket through a sequence of Stages, some run by agents and some
by a human, and gives that human an at-a-glance view plus levers to trigger the
next step or intervene.

## Language

**Ticket**:
A single unit of work Lasso drives from idea to merged. It is an issue in
whatever tracker the target repo's `docs/agents/issue-tracker.md` names.
_Avoid_: issue, work item, task, card

**Stage**:
One step in a Ticket's journey: Grill, Plan, Implement, Document, Review.
Some Stages need a human present; others an agent can run alone.
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
