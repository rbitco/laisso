---
name: lasso
description: Set up or edit Lasso, the tool that drives Tickets through Pipelines of Stages with coding-agent Runners. Use when writing or changing Lasso's config.yaml (repos and their trackers, Actions, Agent Profiles, Runners, Budget), writing or changing a Pipeline or its Stages, diagnosing why a Lasso Ticket is Flagged, linking a PR to a Ticket with `lasso pr` (including from inside a Lasso Session), or starting a review of someone else's PR with `lasso add --pr`.
---

# Lasso

These docs ship with Lasso and match the version that installed them
(`.lasso-version` beside this file). Lasso's terms (Ticket, Pipeline, Stage,
Action, Agent Profile, Runner, Budget, Flagged, Version) are used exactly as
Lasso uses them; say them that way to the user.

## Workflow

1. **Find the Lasso home.** `lasso doctor` prints it on its first line
   (`lasso home: ...`) and works whether or not Lasso is running; `lasso
   status` prints it too, but only while Lasso runs. It is `$LASSO_HOME`
   when set, else `~/.lasso`. A dev clone's `pnpm start` uses `~/.lasso-dev`.
   If doctor's skill lines say this skill is from another Lasso version, run
   `lasso skill install` and reread it.
2. **Read before editing.** Read `config.yaml` and every file in
   `pipelines/` in that home. Done when you know each repo, its tracker and
   default Pipeline, every Action and Agent Profile, and which Pipeline and
   Stage names what. Lasso's own comments in these files are worth keeping.
3. **Make the change** in the files, following the reference that covers it:
   - `config.yaml` (repos, Actions, Budget, everything else): [config.md](config.md)
   - Pipelines and Stages: [pipelines.md](pipelines.md)
   - Agent Profiles and Runners: [profiles.md](profiles.md)
   - Complete, tested homes for a GitHub-tracked and a JIRA-tracked repo:
     [examples/github/](examples/github/) and [examples/jira/](examples/jira/)
   - A Flagged Ticket: [flags.md](flags.md)
   - A Ticket's PRs, Owned and Referenced, `lasso pr`, and `lasso add --pr`: [prs.md](prs.md)
4. **Check it.** Run `lasso doctor`. Done when it prints no config error,
   every needed tool is found and logged in, and each tool's "needed by"
   matches what you meant to configure. Doctor checks config.yaml parses but
   skips a Pipeline that does not: check a Pipeline you wrote against
   [pipelines.md](pipelines.md) line by line, or save it from the dashboard
   (Pipelines page) or `PUT /api/pipelines/<name>`, which refuse a Pipeline
   that does not parse or names a missing Action or profile.
5. **Say what needs a restart.** Tell the user which edits apply now and
   which need Lasso restarted, using the table in [config.md](config.md#when-edits-apply).

**Inside a Lasso Session** (`$LASSO_TICKET` is set), skip the workflow
above for PRs: link any PR you open on a branch other than the Ticket's own
with `lasso pr link <url>`, and one you only read with `--referenced`. See
[prs.md](prs.md).

When a rule here and Lasso disagree, Lasso wins: report the mismatch to the
user rather than working around it.
