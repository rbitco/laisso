# The Laisso home and editing config

## Layout

Everything Laisso owns lives under `~/.laisso`. `LAISSO_HOME` overrides the
whole path, and `LAISSO_DIRECTORY_NAME` changes just the directory's name
under `~`.

| Path          | Holds                                              |
| ------------- | -------------------------------------------------- |
| `config.yaml` | repos, Actions, Agent Profiles, everything else    |
| `pipelines/`  | one Pipeline per `.yaml` file                      |
| `tickets/`    | per-Ticket worktrees, Session logs and launchers   |
| `laisso.db`   | the Ticket store                                   |
| `backups/`    | copies of `laisso.db` taken before each migration  |
| `laisso.log`  | one line per event                                 |
| `laisso.pid`  | the running process's lock                         |

The first run writes a commented `config.yaml` and the default Pipeline and
never touches either again. `laisso setup` edits both with you.

Before an upgrade migrates `laisso.db`, Laisso copies it to `backups/` (the
newest 5 are kept). An older Laisso refuses to open a `laisso.db` a newer
one has migrated.

## Editing config and Pipelines

Pipelines and `config.yaml` can be edited by hand, from the dashboard (the
Pipelines and Config links in the header), or through `/api/pipelines` and
`/api/config`. Dashboard and API edits change only the fields you touched
and keep the file's comments and ordering; nothing is written that does not
parse.

| Setting                                                         | Applies          |
| --------------------------------------------------------------- | ---------------- |
| Budget, concurrency, retention, branch prefix, notifications    | at once          |
| Agent Profiles                                                  | next Session     |
| `port:`, `tick:`                                                | after a restart  |

`repos:` stays a hand edit, though a config edit from the dashboard picks up
any change to it made since Laisso started.

The field reference is in [skills/laisso/config.md](../../skills/laisso/config.md)
and [skills/laisso/pipelines.md](../../skills/laisso/pipelines.md).

## Trackers

Reference intake talks to the tracker through its CLI: `acli jira workitem
view` and a JQL search per transition status for JIRA, `gh issue view` for
GitHub. The one a repo uses must be installed and logged in for reference
Tickets. Prompt Tickets need neither.
