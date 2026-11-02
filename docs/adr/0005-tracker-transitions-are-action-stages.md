---
status: superseded in part by ADR-0010
---

# Tracker status moves are Pipeline action Stages, not Laisso built-ins

Laisso mirrors a Ticket's state to its tracker (ADR 0001). The obvious
design hard-wires the status moves: In Progress at intake, In Review
before the Review Stage, Done at merge. We decided that Laisso only
mirrors automatically what is its own state summary, a `laisso:<stage>`
label swapped on each transition and a `laisso:flagged` label, and that
any status move is a Stage the Pipeline places. This adds a second Stage
kind to ADR 0002: an `action` Stage has no prompt and no Runner; Laisso
runs a named built-in (`tracker.transition <status>` is the first),
records a Session row for it, and auto-advances. Status names and where
they belong are a per-project workflow choice, and the Pipeline is
already the place a project expresses ordering, so a rigid mapping would
be edited around the first time a board's columns differed.

## Consequences

- A Stage is either a prompt run by a Runner or an action Laisso performs
  itself; ADR 0002's declared fields gain a `kind`.
- `tracker.transition` takes the tracker's literal status name. Laisso
  validates every action Stage against the Ticket's tracker at intake,
  so a bad name Flags before any Stage runs. The GitHub adapter accepts
  only `open` and `closed`.
- The built-in catalogue is Laisso code and grows deliberately; a
  Pipeline cannot define new actions.
- A Pipeline that omits the action Stages leaves the tracker's status
  untouched. Labels still move, because they are Laisso's, not the
  Pipeline's.
