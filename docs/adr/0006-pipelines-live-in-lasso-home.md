---
status: accepted, amended by ADRs 0009 and 0011
---

# Pipelines and repo config live in Lasso's home, not in target repos

A Pipeline has to be written down somewhere, and the obvious place is
the repo it drives, next to its other agent docs. We decided instead
that every Pipeline is one YAML file under `~/.lasso/pipelines/`, named
by its basename, and that the repo map (tracker project to local path
and default Pipeline), global Budget defaults, and the poll tick sit in
`~/.lasso/config.yaml`. Target repos carry no Lasso files. Lasso is solo,
multi-repo tooling and nearly every repo runs the same default Pipeline,
so one editable copy beats a scattering of identical ones, and the
dashboard can edit both files in place. The Lasso store references a
Pipeline by name and snapshots the Stage onto each Session (ADR 0001),
so the files stay the single source of truth.

## Consequences

- Both hand edits and dashboard edits write the same file; Lasso uses a
  comment-preserving YAML parser so a UI save keeps hand-written notes.
- The default Pipeline is embedded in Lasso and written to
  `~/.lasso/pipelines/default.yaml` on first run if absent, then never
  touched again. An upgrade ships a new embedded copy and leaves yours.
- A Stage is Runner-run when it has `prompt` or `skills`, and an
  `action` Stage when it has `action`; both is a validation error. The
  Pipeline's `runner` is a default each Runner-run Stage may override.
- `artifact` and `action` values come from built-in catalogues in Lasso
  code (ADR 0005); unknown names fail validation at intake. Action
  Stages on a prompt Ticket are validated once Grill has published its
  issue, since no tracker exists to validate against before then.
- A repeating Stage declares its trigger as `repeat: feedback` and its
  end condition as its `artifact` (ADR 0004).
- Renaming or deleting a Pipeline under a live Ticket does not break the
  running Stage, which is snapshotted, but the next advance Flags with a
  missing-Pipeline reason.
- A repo that needs its own Pipeline in its own tree is a later, one-line
  extension: a repo-local directory whose names shadow the global ones.
