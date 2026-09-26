---
status: accepted
---

# Lasso's poller drives Review Rounds, never a watching Runner

The Review Stage must notice new PR feedback (CI failures, review
comments, verdicts) and have a Runner address it until the PR merges.
The obvious design is one long-running Runner session whose prompt says
"watch the PR and keep fixing things", calling `gh` itself. We decided
instead that no Runner ever polls. Lasso's own scheduler ticks on a
global cadence, fetches feedback with ETag-cached `gh api` calls, diffs
it against a per-Ticket watermark in Lasso's store, and launches one
fresh Session, a Round, only when new Feedback exists. The repeat
trigger and end condition are declared on the Stage, so the loop is a
generic Stage capability rather than Review-specific code (ADR 0002).

A watching Runner burns tokens while idle, dies when the laptop sleeps,
and keeps Round history inside a transcript Lasso cannot read (ADR
0001). A deterministic tick costs at most a few free API calls per
Ticket, survives sleep because the watermark is durable, and gives Lasso
an exact list of what each Round owes.

## Consequences

- Latency is bounded by the tick, one global setting; the dashboard
  offers "check now". Webhook forwarding may fire an early tick but is
  never itself a trigger.
- Lasso renders the Feedback snapshot into the Round's prompt. Feedback
  arriving mid-Round waits for the next Round.
- Runner-posted comments must carry a hidden marker naming the Ticket
  and Round so the next tick does not read them as Feedback. The Runner
  shares the human's GitHub identity, so nothing else distinguishes them.
- A Round is judged like any AFK run: every snapshot item addressed
  (marked reply and resolved thread, marked reply, or a new push for a
  CI failure) or the Ticket is Flagged. The same check failing in two
  consecutive Rounds, or the PR closing unmerged, also Flags.
- Review's declared artifact is a merged PR; merging is a human act.
  Green checks with nothing outstanding is only a displayed state.
- Agent code review is not a Lasso concept. Any earlier Stage that posts
  marked PR comments is Feedback like any other.
