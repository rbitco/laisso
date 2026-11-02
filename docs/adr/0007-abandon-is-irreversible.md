---
status: accepted
---

# Abandon is irreversible; a Ticket's end of life tears down what only Laisso needs

When a Ticket finishes (its last Stage completes) or a human Abandons it,
Laisso has to decide what to keep. We could have made Abandon a pause with
a Reopen action, restoring the worktree and Budget counters. We decided
instead that both ends of life are final: Laisso removes the worktree and
every `laisso:*` label, leaves the tracker's status where the Pipeline
left it, and treats the Ticket row as history. Done also deletes the
local branch, since the PR is merged. Abandon keeps the branch as the
salvage point, first committing any uncommitted work with a marked WIP
commit, and closes an open PR with a marked comment. Intaking the same
issue again makes a new Ticket with a fresh Pipeline and Budget; the
tracker reference is unique among active Tickets only, and a new
worktree checks out the kept branch if it still exists. One end-of-life
path and a plain re-intake are simpler than a Reopen that must rebuild a
worktree and reconcile counters, and a fresh Ticket is what a second
attempt usually wants anyway.

## Consequences

- The per-Ticket directory (`~/.laisso/tickets/<id>/`) outlives the
  worktree so Sessions' stdout stays readable; a global `retention`
  setting (default 30 days) sweeps it after end of life. Store rows are
  never swept, so Budget history and the finished list survive with a
  dead stdout link.
- Abandon kills running headless Sessions (Outcome interrupted); a
  terminal Session is left to the human and no longer tracked.
- Tracker status is never changed by end of life itself (ADR 0005). A
  done Ticket's status is whatever its final action Stage set; an
  Abandoned one stays where it was.
- Mark done or Skip on the last Stage reaches done by the same path.
