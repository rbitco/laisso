# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `rbitco/laisso`. Use
the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --repo rbitco/laisso --title "..." --body-file body.md`.
  Write multi-line bodies to a file first. Label defects `bug`.
- **Read an issue**: `gh issue view <n> --repo rbitco/laisso --comments`.
- **List issues**: `gh issue list --repo rbitco/laisso --state open --json number,title,labels,assignees`.
  Add `--label needs-triage` or similar to filter by triage role.
- **Comment on an issue**: `gh issue comment <n> --repo rbitco/laisso --body "..."` (or `--body-file`).
- **Apply / remove labels**: `gh issue edit <n> --repo rbitco/laisso --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <n> --repo rbitco/laisso --comment "..."`.
- **Assign**: `gh issue edit <n> --repo rbitco/laisso --add-assignee @me`.

Issues are referenced as `#123`. A bare number in conversation means issue `#<number>`.

Older code comments and tests cite keys like `LASSO-123`: those are from the
tracker Laisso used before it went public, and are kept as history.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `rbitco/laisso`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <n> --comments`. If the number isn't given, infer it from
the git branch name (branches carry the issue number, e.g. `42-add-login`).
