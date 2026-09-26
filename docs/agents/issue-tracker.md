# Issue tracker: JIRA

Issues and specs for this repo live as JIRA work items in project `LASSO` on
`mattwatson.atlassian.net`. Use the `acli` CLI (`acli jira workitem ...`) for
all operations. JIRA calls issues "work items"; the two terms are interchangeable here.

## Conventions

- **Create an issue**: `acli jira workitem create --project LASSO --type Task --summary "..." --description-file body.md`.
  Write multi-line bodies to a file first; plain text is accepted. Use `--type Bug` for defects, `--type Epic` for a spec that groups tickets.
- **Read an issue**: `acli jira workitem view LASSO-123 --fields summary,description,labels,status,assignee,parent`,
  then `acli jira workitem comment list --key LASSO-123 --paginate` for the thread.
- **List issues**: `acli jira workitem search --jql 'project = LASSO AND statusCategory != Done' --fields key,summary,labels,status,assignee --json`.
  Add `AND labels = needs-triage` or similar to filter by triage role.
- **Comment on an issue**: `acli jira workitem comment create --key LASSO-123 --body "..."` (or `--body-file`).
- **Apply / remove labels**: `acli jira workitem edit --key LASSO-123 --labels "..." --yes` / `--remove-labels "..." --yes`.
- **Close**: `acli jira workitem transition --key LASSO-123 --status Done --yes`, after a closing comment.
- **Assign**: `acli jira workitem assign --key LASSO-123 --assignee @me`.

Issue keys look like `LASSO-123`. A bare number in conversation means `LASSO-<number>`.

## When a skill says "publish to the issue tracker"

Create a JIRA work item in project `LASSO`.

## When a skill says "fetch the relevant ticket"

Run `acli jira workitem view <key>` plus `comment list`. If the key isn't given, infer it
from the git branch name (branches carry the JIRA key, e.g. `lasso-42-add-login`).

## Wayfinding operations

Used by `/wayfinder`. The **map** is an Epic with **child** work items as tickets.

- **Map**: an Epic labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `acli jira workitem create --project LASSO --type Epic --label wayfinder:map ...`
- **Child ticket**: a Task with `--parent LASSO-<map>`. Labels: `wayfinder:<type>`
  (`research`/`prototype`/`grilling`/`task`). Once claimed, assign to the driving dev.
- **Blocking**: JIRA's native issue links. `acli jira workitem link create --out LASSO-<blocker> --in LASSO-<child> --type Blocks`.
  A ticket is unblocked when every blocker is Done.
- **Frontier query**: `--jql 'parent = LASSO-<map> AND statusCategory != Done AND assignee IS EMPTY'`,
  then drop any with an open inward `Blocks` link (`acli jira workitem link list`); first in map order wins.
- **Claim**: `acli jira workitem assign --key LASSO-<n> --assignee @me`, the session's first write.
- **Resolve**: comment the answer, transition to Done, then append a context pointer
  (gist + link) to the map's Decisions-so-far by editing the Epic description.
