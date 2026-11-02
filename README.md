# Laisso

Laisso runs coding agents through your own development process. You give it
a Ticket (a tracker issue or a plain prompt), and it walks the Ticket through
a Pipeline of Stages, such as plan, implement, open the PR and answer review,
using Claude Code, Codex or Pi. Each Ticket gets its own git worktree. Every
Ticket shows on a local dashboard, where you step in when a Stage needs you.

## Requirements

- macOS. Human Stages open in Terminal.app, tmux or herdr.
- Node 24 or later.
- At least one coding agent, installed and logged in: [Claude Code](https://claude.com/claude-code)
  (`claude`), [Codex](https://github.com/openai/codex) (`codex`) or Pi (`pi`).
- `git`, and [`gh`](https://cli.github.com) logged in, for PRs and GitHub issues.
- [`acli`](https://developer.atlassian.com/cloud/acli/) logged in, only for JIRA issues.

## Quickstart

```sh
npm i -g laisso
laisso setup     # a coding agent sets up your repos and Pipelines with you
laisso           # start Laisso; the dashboard is at http://localhost:7433
laisso add "Add a dark mode toggle" --repo app
```

`laisso setup` opens your default coding agent in this terminal, in the
Laisso home (`~/.laisso`). It asks one question at a time, shows each change
before writing it, and works through:

1. which coding agents you have, and the Agent Profiles that run them,
2. which repos Laisso should work in, suggested from your checkouts and
   `gh repo list`,
3. a default Pipeline shaped to how you work, using only skills you already
   have installed,
4. more Pipelines for special kinds of work, until you say stop,
5. a final `laisso doctor` check.

Pass `--profile <name>` to run setup under a different Agent Profile. The
dashboard also offers a Set up Laisso button until a repo is added.

Without setup, Laisso still runs: the first start writes a commented
`config.yaml` and a starter Pipeline (plan with you, implement, open the PR,
answer review until it merges). Add repos to `config.yaml` by hand.

## How it works

- A **Ticket** is one unit of work, made from a tracker issue or a prompt.
  It runs in its own worktree on its own branch.
- A **Pipeline** is the ordered list of **Stages** a Ticket walks through,
  one YAML file per Pipeline.
- A Stage is run by a coding agent (a **Runner**), headless or in a terminal
  with you, or is an **Action**: a shell command such as moving the tracker
  issue or running tests.
- An **Agent Profile** says which Runner, model and permissions a Stage uses.
- An **Artifact** is what a Stage must leave behind before the Ticket moves
  on, such as commits on the branch, a PR or a file.
- A Ticket is **Flagged** when it needs a person: its attempts or spend ran
  out, or review feedback still stands. The dashboard says why and offers
  the ways out.

The full glossary is [CONTEXT.md](CONTEXT.md).

## Commands

| Command                              | Does                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `laisso`                             | start Laisso: dashboard, tick and Sessions                |
| `laisso setup`                       | set up repos and Pipelines with a coding agent            |
| `laisso add <ref \| prompt>`         | make a Ticket from a tracker reference or a prompt        |
| `laisso add <prompt> --pr <pr> --pipeline pr-review` | review a teammate's PR                    |
| `laisso status [ticket]`             | print the Ledger, or one Ticket's detail                  |
| `laisso check [ticket]`              | run a tick now and print what changed                     |
| `laisso pr link \| unlink \| list`   | manage the PRs linked to a Ticket                         |
| `laisso doctor`                      | list the tools Laisso needs and whether each is ready     |
| `laisso skill install`               | install the Laisso skill for Claude Code and Codex        |

`laisso --help` lists every option.

The Laisso skill teaches a coding agent how to write `config.yaml` and
Pipelines and why a Ticket is Flagged, from docs that match the installed
version. `laisso setup` installs it; after an upgrade, rerun `laisso skill
install`, as `laisso doctor` will say.

## Upgrading

`npm update -g laisso`, then restart Laisso. The dashboard and `laisso
status` say when a newer version is published, and when one is installed
but not yet running. `npm i -g laisso@next` installs the latest preview from
main; `npm i -g laisso@latest` goes back to the last release.

## Guides

- [The Laisso home and editing config](docs/guide/home.md)
- [Agent Profiles](docs/guide/profiles.md)
- [Terminals and Take over](docs/guide/terminals.md)
- [Budgets, Flags and concurrency](docs/guide/budgets.md)
- [The Review loop](docs/guide/review-loop.md)
- [Shutdown, restart and end of life](docs/guide/lifecycle.md)

Field references for `config.yaml`, Pipelines and profiles are in
[skills/laisso](skills/laisso/SKILL.md), with worked examples for GitHub
and JIRA in [skills/laisso/examples](skills/laisso/examples).

## Coming from Lasso

Laisso was named Lasso. Install `laisso`, uninstall `@rbitco/lasso`, and set
`LAISSO_DIRECTORY_NAME=.lasso` to keep using `~/.lasso` as it is: its
`lasso.db`, `lasso.log` and backups are picked up, `LASSO_HOME` and
`LASSO_PORT` still work, and Sessions and Actions get each `LAISSO_*`
variable under its `LASSO_*` name too, so Action scripts written for Lasso
run unchanged. Prompts that tell an agent to run `lasso route` or `lasso pr
link` need `laisso` instead, as no `lasso` command is installed. `laisso
skill install` removes the skill Lasso installed. Tracker issues keep their
old `lasso:*` labels beside the new `laisso:*` ones until removed by hand.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for running from a clone, tests and
releases. The spec is [docs/spec/laisso-v1.md](docs/spec/laisso-v1.md), and
decisions are in [docs/adr](docs/adr).

## License

[MIT](LICENSE)
