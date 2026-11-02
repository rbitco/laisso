---
status: accepted
---

# Laisso owns Ticket state; the tracker is a mirror

Laisso must work across JIRA and GitHub, and it needs to remember things
neither tracker models: Budget spend, Stage run history, Review Rounds. We
decided Laisso keeps the authoritative record of a Ticket's Stage and history
in its own store and writes a summary (labels or status) back to the tracker.
The alternative, treating the tracker's labels as the truth and keeping Laisso
stateless, was simpler but left Budget history with nowhere to live and tied
Laisso's state model to whichever tracker had the weakest label support.

## Consequences

- The tracker can drift from Laisso's view; mirroring must be idempotent and
  re-runnable.
- Humans who change a label in the tracker are not changing the Ticket's
  Stage unless Laisso is told to re-read it.
