---
status: accepted
---

# Actions are shell commands defined in config

ADR 0005 made tracker status moves action Stages drawn from a catalogue
in Lasso's code, so every new action (post a comment, ping a channel,
run a script) waited on a Lasso release. We decided that an Action is a
named shell command in `config.yaml`, and a Pipeline's action Stage only
refers to one by name and passes it named params. Lasso hands the
command the Ticket's details and the params as `LASSO_*` environment
variables, runs it in the Ticket's worktree, and judges it by exit code.
The Pipeline says *when* an Action runs; the config says *what* it does,
so one Pipeline serves repos whose trackers or tooling differ. This
supersedes ADR 0005's closed catalogue and ADR 0006's rule that action
names come from Lasso code.

## Considered Options

- Keep built-ins beside config Actions: keeps `tracker.transition`'s
  status check at Intake, but leaves two kinds of action with different
  rules. `tracker.transition` becomes an ordinary config Action instead.
- Commands inside the Pipeline: couples a Pipeline to one machine's
  tools and makes the same Pipeline unusable across JIRA and GitHub.
- Template substitution (`{{status}}`) in the command: reads well but
  lets a tracker title with quotes or `$( )` inject shell unless Lasso's
  escaping is perfect. Environment variables leave quoting to the shell.

## Consequences

- An Action has `run`, optional `params` (names a Stage must supply
  under `with:`), and optional `timeout` (default 5m). A repo may
  redefine an Action by name under its own `actions:`; the repo's wins.
- Variables: the `LASSO_*` set Runner Sessions get, plus the Ticket's
  title, tracker, project, PR, worktree, and Pipeline, plus one
  `LASSO_<PARAM>` per param, upper-cased.
- Exit 0 succeeds and the Ticket advances; non-zero Flags like any failed
  Session. Output is kept as the Session's stdout and its last line is
  the final message. A command past its timeout is killed and fails.
- Saving a Pipeline and Intake check only that each action Stage names
  an Action the repo has and supplies its params. Whether a status
  exists on the board is found out when the Action runs, not at Intake.
- Migration writes `tracker.transition` into `config.yaml` (acli
  globally, a gh override per GitHub repo) and rewrites `status: X` to
  `with: { status: X }` in Pipeline files and pinned Versions. The old
  form then fails validation.
- Actions are edited in `config.yaml` only; the dashboard lists them and
  offers them in the Pipeline editor.
