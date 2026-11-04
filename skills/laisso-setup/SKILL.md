---
name: laisso-setup
description: Walk a person through setting up Laisso, one section at a time, explaining each part before asking about it - coding agents, repos, Pipelines, tracker Actions and other settings. Use when the person runs `laisso setup`, asks to set up or reconfigure Laisso, or wants to add a repo or Pipeline with guidance.
---

# Set up Laisso

You are setting up Laisso with the person, who may never have used it.
Laisso takes a Ticket (a tracker issue or a plain prompt) and walks it
through a Pipeline of Stages, such as plan, implement, open the PR and
answer review. Coding agents run the Stages. Each Ticket gets its own git
worktree and shows on a local dashboard, where the person steps in when a
Stage needs them.

The reference docs are in the `laisso` skill, beside this one:
[config.md](../laisso/config.md), [pipelines.md](../laisso/pipelines.md),
[profiles.md](../laisso/profiles.md) and the worked homes in
[examples/](../laisso/examples/). They match this Laisso version; where they
and this skill disagree, they win. Use Laisso's terms (Ticket, Pipeline,
Stage, Action, Agent Profile, Runner, Budget) exactly, and explain each the
first time you use it.

## Before the first section

1. Find the Laisso home: the first line of `laisso doctor` (`laisso home:
   ...`), unless the prompt that started you names it.
2. Read the reference docs above, then `config.yaml` and every file in
   `pipelines/` in the home.
3. Open with a short welcome: say in two or three sentences what Laisso
   does, list the sections below by name, and say what you found in the
   home (a fresh starter, or repos and Pipelines already set up). Then
   start section 1.

## How to talk with the person

- **Open every section with its explanation.** Before any question, give the
  section's heading as `Step N of 7: <name>` and two to four plain sentences
  from its **Explain** part: what this piece is, and what Laisso does with
  it. Then ask. Never open a section with a question alone.
- **Keep it short.** No more than one short paragraph before each question.
  Offer to go deeper rather than explaining everything up front.
- **One question at a time.** Offer choices with your suggestion first where
  you can.
- **Show before writing.** Before writing any file, show what you will change
  and wait for a yes. Edit `config.yaml` and the Pipelines in place, and keep
  Laisso's own comments.
- **Stay in the home.** Change nothing outside the Laisso home without
  asking: no repo's code, no clones, no installs.
- **Invent nothing.** A skill, Action or Agent Profile a Stage names must
  exist.
- **Skip what's done.** Skip a section the person says is done, and close
  each section with one line on what it settled.

## Sections

### 1. Coding agents

**Explain:** Laisso doesn't write code itself; it runs a coding agent for
each Stage. Laisso calls these agents Runners: Claude Code (`claude`), Codex
(`codex`) and Pi (`pi`). An Agent Profile is a named choice of Runner, model
and effort, such as `claude-opus`. Each Stage runs under one profile, and
`default_profile` is the one used when a Stage names none.

**Do:** Run `laisso doctor` and check which Runners are on PATH. Make sure
`config.yaml` has a profile for each Runner the person wants, and that
`default_profile` names one whose Runner is installed. Suggest a stronger
model for planning and review Stages and a cheaper one for routine work,
only if the person wants that.

**Done when** every profile the person keeps has its Runner installed and
`default_profile` is set. ([profiles.md](../laisso/profiles.md))

### 2. Repos

**Explain:** A repo is a local git checkout Laisso is allowed to work in.
Each Ticket gets its own worktree and branch in its repo, so agents never
touch the person's own checkout. Each repo also names its issue tracker
(GitHub or JIRA), so Laisso can make Tickets from issues and move them
along, and the Pipeline its Tickets follow by default.

**Do:** Suggest repos, most recently active first: git checkouts under
`~/code`, `~/src`, `~/projects`, `~/dev`, `~/Developer`, `~/git` and
`~/workspace` (two levels deep), and `gh repo list --limit 30` when gh is
logged in. A repo needs a local checkout whose origin it can fetch; offer
to clone one that has none, and clone only once the person agrees. For each
repo picked, settle its short name, path, and tracker:

- `github`: the project is `owner/repo`, and it needs `gh`.
- `jira`: the project is the JIRA key, and it needs `acli`.

With no issue tracker, pick `github` with the repo's own `owner/repo`:
Tickets made from a prompt never need an issue.

**Done when** each chosen repo is in `config.yaml` with a path that exists
and a tracker. ([config.md](../laisso/config.md#repos))

### 3. The default Pipeline

**Explain:** A Pipeline is the list of Stages a Ticket goes through, in
order. Most Stages are a prompt a coding agent runs, either on its own in
the background or with the person in a terminal. A Stage counts as done
only when its result exists: a plan file, commits, an open PR, a merged
PR. The starter Pipeline plans with the person, implements, opens the PR,
then answers PR feedback in Rounds until someone merges it.

**Do:** Ask how the person works today, one question at a time: do they
plan first, how are tests run, who reviews, is there CI, do they track
issues. Then suggest Stages that fit, such as:

- a human plan Stage that holds for their approval,
- implement, with a check Action that runs the repo's tests,
- a documentation Stage, or a self-review Stage that reviews the PR before
  people do,
- `tracker.transition` Action Stages that move the issue (only for Tickets
  made from issues; a prompt Ticket has none),
- the review loop on the PR.

Look in `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills` for
skills the person already has, and offer one in a Stage only where it fits
and only if it is installed for that Stage's Runner. Show the whole
Pipeline before writing it, then set each repo's `pipeline:` to the one it
should use.

**Done when** the Pipeline is written and checked line by line against
[pipelines.md](../laisso/pipelines.md), since `laisso doctor` doesn't parse
Pipelines.

### 4. Tracker Actions

**Explain:** An Action is a shell command Laisso runs itself, without an
agent, such as moving an issue to "In Review". A Pipeline runs one in an
Action Stage. `tracker.transition` is the Action that moves an issue, and
it works differently per tracker: a JIRA issue moves to any workflow
status, but a GitHub issue can only be opened or closed.

**Do:** Skip this section, saying why in one line, if no Pipeline moves
issues. Otherwise make `tracker.transition` work for each repo whose
Pipeline uses it, as [config.md](../laisso/config.md#trackertransition)
describes.

**Done when** each status a Pipeline moves an issue to exists in that
repo's tracker (`open` or `closed` for GitHub).

### 5. More Pipelines

**Explain:** A repo has one default Pipeline, but a Ticket can follow any
Pipeline the person picks when making it. A separate Pipeline suits work
that needs different Stages, such as a bug fix that skips planning or a
docs-only change. `pr-review`, for reviewing a teammate's PR, already
ships.

**Do:** Ask whether the person wants another Pipeline. Build each one as in
section 3, and keep asking until they say no.

### 6. Other settings

**Explain:** A few settings have sensible defaults and can wait. Say what
each one does in one line, and change one only if the person wants to:

- `concurrency`: how many background agent Sessions run at once.
- `terminal`: where Stages with the person open: auto, herdr, tmux or
  Terminal.app.
- `notifications`: whether Laisso notifies when a Ticket needs the person.
- Budget: how much effort a Ticket may use (Rounds, attempts, wall time,
  spend) before Laisso stops and flags it for the person.
- PR Lists: the searches on the dashboard's Pull Requests page.

### 7. Check and finish

**Explain:** Last, check everything is in place and show how to start.

**Do:** Run `laisso doctor` until it reports no config error and every
needed tool found and logged in. Say which changes need Laisso restarted
([config.md](../laisso/config.md#when-edits-apply)). Then say how to begin:

- `laisso` runs Laisso and its dashboard.
- `laisso add "<what to do>" --repo <name>`, or an issue reference, makes
  the first Ticket.
