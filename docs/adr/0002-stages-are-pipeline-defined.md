---
status: accepted
---

# Laisso has no built-in Stage semantics; Pipelines define Stages

Laisso started with five named Stages (Grill, Plan, Implement, Document,
Review) and could have special-cased each: Laisso knowing that Document
opens the PR, that Review polls feedback. We decided instead that a Stage
is whatever a Pipeline declares: a name, a prompt, a Runner, a
human-in-the-loop flag, an auto-advance flag, and a declared artifact.
Laisso runs Stages generically and the five are only the default Pipeline's
names. Projects differ enough that any fixed set would be edited around
immediately, and Stage-specific code in Laisso would have to grow with every
such edit.

## Consequences

- Anything Laisso must know about a Stage has to be expressible in those
  declared fields; behaviour that can't be lives in the prompt.
- Done for an agent-run Stage is judged the same way everywhere: the Runner
  reports success and the declared artifact exists, otherwise the Ticket is
  Flagged. Laisso never infers completion from Stage-specific signals.
- Renaming or reordering the default Stages is a Pipeline edit, not a Laisso
  change.
