---
status: accepted
---

# Tickets pin a Pipeline Version at Intake

The dashboard needed to add, remove, and reorder Stages, and any such
edit could strand a live Ticket: its current Stage is found by name, so a
removal Flags it and a reorder silently skips or repeats Stages. We could
have warned before saving, or blocked edits that touch a live Ticket's
Stage. We decided instead that Intake freezes the Pipeline into Laisso's
store and pins the Ticket to that Version, so no later edit to the file,
by hand or from the dashboard, reaches a Ticket already under way. The
YAML file stays the only thing a human edits and is always the current
Pipeline; Versions exist only where a Ticket uses them. This amends ADR
0006: the file is the source of truth for new Tickets, not live ones.

## Considered Options

- Warn on save, listing affected Tickets: still lets one edit derail
  several Tickets mid-flight, and says nothing about hand edits.
- Block edits touching a live Ticket's Stage: makes the editor unusable
  whenever the default Pipeline is busy, which is most of the time.
- Versioned files on disk or git history of `~/.laisso`: makes hand
  edits either create files themselves or pull git into Laisso's home.

## Consequences

- A Version is numbered (v1, v2, ...) when Intake first snapshots content
  that differs from the Pipeline's last Version. Edits no Ticket was ever
  bound to get no number.
- A Version holds the Pipeline's own runner and Budget; global config is
  not snapshotted and still applies live.
- Renaming or deleting a Pipeline no longer Flags live Tickets, which
  carry on with their Version. This replaces ADR 0006's missing-Pipeline
  Flag. A renamed file is a new Pipeline starting at v1.
- A human may upgrade a Ticket to the current Pipeline. It keeps its
  Stage by name; when that Stage is gone, the human picks where it lands.
  Upgrade waits for any running Session to end and leaves Session and
  Round history as it is.
- There is no disabled state for a Pipeline or a Version: only the
  current Pipeline is offered at Intake, and deleting the file retires it.
- Migration pins every live Ticket to its Pipeline file as v1.
