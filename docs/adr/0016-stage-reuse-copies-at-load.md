---
status: accepted
---

# Stage reuse copies at load

People kept writing the same Stages into several Pipelines (a bug-fix
Pipeline that is the default one minus planning, a review Stage everyone
wants) and then editing each copy by hand. We let a Pipeline take Stages
from another with `use: <pipeline>.<stage>` and `include: <pipeline>`,
and we expand those entries when the Pipeline loads: the reusing Pipeline
becomes a flat list of Stages, its own and copied, each copy carrying
only a note of where it came from. Everything downstream (Versions,
Routes, Visits, the Ticket page, Runners) sees ordinary Stages and did
not change.

## Considered Options

- Runtime sub-Pipelines, where a Stage hands the Ticket to another
  Pipeline and resumes after it: Tickets would follow several Pipelines
  and Versions at once, Routes would cross Pipeline boundaries, and Visits,
  Budgets and Upgrade would all need a notion of nesting.
- Templates rendered to files (a generator that writes the expanded YAML):
  no tie back to the source, so a fix to the source has to be regenerated
  everywhere, and hand edits to the output are lost.

## Consequences

- An edit to a source Pipeline changes every Pipeline that reuses it, at
  their next load. A save or delete that would stop a reuser loading is
  refused until confirmed, and the editor lists who reuses a Pipeline.
- Live Tickets are untouched: their Version froze the expanded Stages
  (ADR 0009), and the Ticket page names each copy's source from the
  Version even after the source is gone.
- A Pipeline can fail to load because of another file. `laisso doctor`
  lists every Pipeline that doesn't load and why.
- The dashboard edits a reusing Pipeline through its expanded list and
  writes changes back as entries (`skip`, `change`, split includes, `use`),
  so the file keeps its reuse instead of being flattened.
- `intake: false` keeps a Pipeline as parts: it lends Stages and takes no
  Tickets.
