---
status: accepted
---

# Artifacts may be check Actions

An Artifact was named from a catalogue in Lasso's code, so every new
idea of "done" (CI green, PR approved, deployed to staging) waited on a
Lasso release, and a repeating Stage could end only when its PR merged.
We decided a Stage's Artifact may name an Action from `config.yaml`,
with params under `with:`, and Lasso runs it as a check: exit 0 is met,
exit 1 is not met, and any other code or a timeout means the check
broke. A check Action may also end a repeating Stage, run after each
Round, on each poll, and on Check PR now. This extends ADR 0010's
Actions to Artifacts and loosens ADR 0004's merge-only end of Review.

## Considered Options

- A separate `checks:` section: keeps commands that look apart from
  commands that change things, but duplicates everything Actions have
  (params, per-repo override, timeout) for no difference Lasso enforces.
- Commands inline in the Pipeline: ties a Pipeline to one machine's
  tools, rejected for Actions in ADR 0010 for the same reason.
- Any non-zero exit as not met: simpler, but a broken check (expired
  login, typo) on a repeating Stage would wait silently forever.
- A merge always ends a repeating Stage as well: safer, but then the
  check could not hold a Stage open after merging. Instead a merged PR
  whose check is still not met Flags, so nothing waits on a PR that can
  get no more Feedback.

## Consequences

- Built-in Artifacts and pinned Versions are unchanged; no migration.
- `artifact.error` joins `artifact.missing` as a Flag reason.
- Lasso keeps only the latest check result per Ticket and Stage, not a
  Session per run, so polling does not bury a Ticket's history.
- A closed, unmerged PR still Flags `review.pr_closed`.
- Nothing stops a check Action from changing things; checks should only
  look.
