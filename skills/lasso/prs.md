# A Ticket's PRs

A Ticket can have several PRs, each linked in one of two roles:

- **Owned PR**: A pull request that carries a Ticket's own work. Lasso polls
  it for Feedback, runs Rounds on it, and waits for it to merge. A Ticket may
  have several; a PR is Owned by at most one active Ticket.
- **Referenced PR**: A pull request a Ticket points at for context, such as
  a teammate's PR under review. Lasso never comments on it, closes it, or
  waits on it.

The Tick links the PR on the Ticket's own branch by itself, as Owned. Any
other PR is linked with `lasso pr`.

## Commands

```sh
lasso pr link <pr> [ticket] [--referenced]   # link as Owned, or Referenced
lasso pr unlink <pr> [ticket]                # unlink it
lasso pr list [ticket] [--json]              # the Ticket's PRs, in link order
```

- `<pr>` is any of: the PR's URL, `owner/repo#N`, `#N`, or `N`. `#N` and `N`
  mean a PR in the Ticket's own repo, which needs a GitHub origin. Quote
  `#N` in a shell (`lasso pr link '#7'`), or the shell reads it as a comment.
- `[ticket]` is the Ticket as `lasso status` takes it. Left out, it is
  `$LASSO_TICKET`, which every Session has, so inside a Session the Ticket
  is never needed.
- Linking a linked PR again switches its role. An Owned PR must be in the
  Ticket's repo and Owned by no other active Ticket; link such a PR with
  `--referenced` instead. An Abandoned Ticket takes no links.
- Unlinking keeps Lasso's hands off the PR: the Tick does not link the
  branch PR again. `lasso pr link` brings it back.
- `--json` prints each PR with its role, who linked it (`branch`, `human`,
  or `agent`), state, title, head and base branch.

## When an agent links

Every Session's prompt lists the Ticket's linked PRs (URL, role, title,
head and base branch) as they were when the Session started; `lasso pr list
--json` shows them as they are now. In a Session:

- **Opened a PR on a branch other than the Ticket's own**: run `lasso pr
  link <url>` so Lasso polls it for Feedback and waits for it to merge. The
  PR on the Ticket's branch needs no link; the Tick finds it.
- **Reading a PR for context** (a teammate's work, a dependency):
  `lasso pr link <url> --referenced`, so humans see it beside the Ticket.
- **Never** link a PR another Ticket owns as Owned, and never unlink a PR a
  human linked unless asked.
