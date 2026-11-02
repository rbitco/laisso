---
name: laisso
description: Set up or edit Laisso, the tool that drives Tickets through Pipelines of Stages with coding-agent Runners. Use when writing or changing Laisso's config.yaml (repos and their trackers, Actions, Agent Profiles, Runners, Budget), writing or changing a Pipeline or its Stages, diagnosing why a Laisso Ticket is Flagged, linking a PR to a Ticket with `laisso pr` (including from inside a Laisso Session), or starting a review of someone else's PR with `laisso add --pr`.
---

# Laisso

These docs ship with Laisso and match the version that installed them
(`.laisso-version` beside this file). Laisso's terms (Ticket, Pipeline, Stage,
Action, Agent Profile, Runner, Budget, Flagged, Version) are used exactly as
Laisso uses them; say them that way to the user.

## Workflow

1. **Find the Laisso home.** `laisso doctor` prints it on its first line
   (`laisso home: ...`) and works whether or not Laisso is running; `laisso
   status` prints it too, but only while Laisso runs. It is `$LAISSO_HOME`
   when set, else `~/$LAISSO_DIRECTORY_NAME` when that is set (`~/.lasso`
   for a home Lasso made), else `~/.laisso`. A dev clone's `pnpm start` uses
   `~/.laisso-dev`.
   If doctor's skill lines say this skill is from another Laisso version, run
   `laisso skill install` and reread it.
2. **Read before editing.** Read `config.yaml` and every file in
   `pipelines/` in that home. Done when you know each repo, its tracker and
   default Pipeline, every Action and Agent Profile, and which Pipeline and
   Stage names what. Laisso's own comments in these files are worth keeping.
3. **Make the change** in the files, following the reference that covers it:
   - `config.yaml` (repos, Actions, Budget, everything else): [config.md](config.md)
   - Pipelines and Stages, and Routes between them (`laisso route`): [pipelines.md](pipelines.md)
   - Agent Profiles and Runners: [profiles.md](profiles.md)
   - Complete, tested homes for a GitHub-tracked and a JIRA-tracked repo:
     [examples/github/](examples/github/) and [examples/jira/](examples/jira/)
   - A Flagged Ticket: [flags.md](flags.md)
   - A Ticket's PRs, Owned and Referenced, `laisso pr`, and `laisso add --pr`: [prs.md](prs.md)
4. **Check it.** Run `laisso doctor`. Done when it prints no config error,
   every needed tool is found and logged in, and each tool's "needed by"
   matches what you meant to configure. Doctor checks config.yaml parses but
   skips a Pipeline that does not: check a Pipeline you wrote against
   [pipelines.md](pipelines.md) line by line, or save it from the dashboard
   (Pipelines page) or `PUT /api/pipelines/<name>`, which refuse a Pipeline
   that does not parse or names a missing Action or profile.
5. **Say what needs a restart.** Tell the user which edits apply now and
   which need Laisso restarted, using the table in [config.md](config.md#when-edits-apply).

**Inside a Laisso Session** (`$LAISSO_TICKET` is set), skip the workflow
above for PRs: link any PR you open on a branch other than the Ticket's own
with `laisso pr link <url>`, and one you only read with `--referenced`. See
[prs.md](prs.md).

When a rule here and Laisso disagree, Laisso wins: report the mismatch to the
user rather than working around it.
