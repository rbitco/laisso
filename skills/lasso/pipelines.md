# Pipelines

A Pipeline is one YAML file in `<Lasso home>/pipelines/`. Its name is the
file name without `.yaml` (or `.yml`): lowercase letters, digits and
hyphens, starting with a letter or digit. Lasso writes `default.yaml` on
first start and never touches it again; edit it or add others freely.

Editing a Pipeline never changes a Ticket already under way: Intake pins a
frozen Version (v1, v2, ...) of the Pipeline, and the Ticket runs that
Version to the end. Deleting or renaming a Pipeline does not stop its
Tickets either. Only new Intakes see an edit. Actions and Agent Profiles are
not frozen: a Stage of an old Version still runs the Action and profile
config.yaml has now.

## Top level

| Field | Rule |
| --- | --- |
| `stages` | required, a non-empty list of Stages, run in order |
| `profile` | optional: the Agent Profile every Runner Stage inherits |
| `budget` | optional: only `spend` (USD per Ticket, number 0 or more). `rounds`, `attempts` and `wallTime` belong on a Stage. |

Any other top-level field is an error. `runner:` is the old form: write
`profile:` and define the profile in config.yaml.

## Stages

A Stage is a **Runner Stage** when it has `prompt` or `skills`, an
**action Stage** when it has `action`. Both, or neither, is an error. Stage
names are lowercase letters, digits and hyphens, unique in the Pipeline.

### Runner Stage

| Field | Default | Rule |
| --- | --- | --- |
| `name` | | required |
| `prompt` | | text the Runner gets after the Ticket preamble |
| `skills` | `[]` | list of skill names, invoked in the Runner's own form (Claude `/name`, Codex `$name` linked to `<skills_dir>/<name>/SKILL.md`, Pi `/skill:name`), ahead of everything else in the prompt. The skill must be installed where that Runner finds it. |
| `profile` | inherit | the Agent Profile this Stage runs under; see [profiles.md](profiles.md#which-profile-a-stage-runs-under) |
| `human` | `false` | `true` opens the Runner in a terminal for the human, who marks the Stage done from the dashboard |
| `advance` | `true` | `false` holds the Ticket after this Stage until a human presses Start on the next one |
| `artifact` | none | what must exist for the Stage to count as done; see [Artifacts](#artifacts) |
| `repeat` | none | only `feedback`: the Review loop. Needs an `artifact` as its end condition, normally `pr-merged`. |
| `budget` | inherit | `rounds`, `attempts` (whole numbers, 0 or more), `wallTime` (duration). `spend` belongs on the Pipeline. |

Any other field is an error; `runner` and `runnerOptions` are the old forms
and name the fix.

Every Runner Session's prompt starts with a preamble Lasso writes: the
Ticket id and reference, repo, branch, Stage, the issue title, and its body
(or the prompt, for a prompt Ticket). The Session also gets `LASSO_TICKET`,
`LASSO_REFERENCE`, `LASSO_REPO`, `LASSO_BRANCH`, `LASSO_STAGE`,
`LASSO_SESSION`, and in a Round `LASSO_ROUND` and `LASSO_MARKER`. So a
prompt need not restate the Ticket.

A headless Stage is done when its Session's Outcome is succeeded and its
artifact is present; otherwise the Ticket is Flagged (an interrupted or
exhausted Session is retried first while attempts remain). A human Stage is
done when the human marks it done; a missing artifact then warns and can be
overridden.

Take over in terminal stops a headless Stage's running Session (or clears
its Flag) and re-enters that Runner session in a terminal; from then the
Stage is worked as a human Stage. Codex can be taken over only once it has
reported its thread id. Hand back gives a taken-over Stage back to Lasso:
a Review Stage returns to Rounds (Feedback that arrived meanwhile opens the
next one), and any other Stage runs headless again on the same Runner
session. A Review Stage taken over and never handed back runs no Rounds.

For an approval step, let one Stage draft and stop for Start, then a second
act on the draft:

```yaml lasso-pipeline
stages:
  - name: plan
    prompt: Draft a plan in PLAN.md. Do not change any code.
    advance: false
    artifact: file PLAN.md
  - name: implement
    prompt: Carry out PLAN.md.
```

While the Ticket holds after `plan`, **Open plan in terminal** re-enters the
draft's session to read or revise it (Lasso keeps no Session row for that
window), and **Start implement** is the approval.

### Repeating Stage (`repeat: feedback`)

Each Tick Lasso polls the Ticket's PR with `gh`. New Feedback (failed
checks, review threads, comments, a changes-requested verdict) starts a
Round: a Session whose prompt lists what to address and the marker
(`<!-- lasso:<ticket>:<stage>:round-<n> -->`) the Runner must end each PR
comment with. A thread counts as addressed once it has a marked reply and
is resolved. The Stage finishes when the PR merges; `budget.rounds` caps the
Rounds. The prompt should tell the Runner to reply with the marker, push,
and resolve what it fixed, as the default Pipeline's `review` Stage does.

### Action Stage

| Field | Rule |
| --- | --- |
| `action` | required: an Action name from config.yaml |
| `with` | mapping of param to a single value; must supply exactly the Action's `params` |
| `name` | optional; defaults to the Action's last dotted part plus the param values, hyphenated: `tracker.transition` with `status: In Progress` is `transition-in-progress` |

Nothing else is allowed (`status:` is the old form of `with: { status: ... }`).
An action Stage always advances on success. Parsing alone cannot see
config.yaml: Intake and saving from the dashboard also check that the
Action exists for the repo and the params match, and that every profile
named exists.

```yaml lasso-pipeline
stages:
  - name: implement
    skills: [implement]
    artifact: commits-on-branch
    prompt: |
      Implement the issue. Commit to the current branch; do not push.

  - action: tracker.transition
    with: { status: In Review }
```

## Artifacts

| Artifact | Present when |
| --- | --- |
| `commits-on-branch` | the branch has commits beyond `origin/<default branch>` |
| `pr-exists` | the branch has a PR (read with `gh`) |
| `pr-review` | the branch's PR has a review |
| `pr-merged` | the branch's PR is merged |
| `file <path>` | `<path>` exists in the worktree; relative, no `..` |
| `tracker-spec`, `tracker-comment` | accepted, but **this Lasso cannot check them yet**: a headless Stage declaring one is Flagged `artifact.missing` ("cannot be checked yet") every time, and Mark done on a human Stage always warns. Leave them off headless Stages. |

Any other artifact is an error. A Stage with a `pr-*` artifact or
`repeat: feedback` needs `gh`.

## Budget

The most specific value wins per dimension: the Ticket's own (set by
Extend), then the Stage's (`rounds`, `attempts`, `wallTime`) or the
Pipeline's (`spend`), then config.yaml's `budget:`.

```yaml lasso-pipeline
profile: claude-opus
budget:
  spend: 40
stages:
  - name: review
    repeat: feedback
    artifact: pr-merged
    budget: { rounds: 8, attempts: 3, wallTime: 1h }
    prompt: |
      Address each unaddressed Feedback item below. Reply on each thread
      with the marker, commit, push, then resolve each thread you fixed.
```

## The default Pipeline

`default.yaml` as Lasso writes it runs grill (human, holds before the next
Stage), a `tracker.transition` to `In Progress`, plan, implement, document
(opens the PR), code-review, a transition to `In Review`, review (the
repeating Stage), and a transition to `Done`. Its grill and plan Stages
declare `tracker-spec` and `tracker-comment` (see [Artifacts](#artifacts)),
and its transitions use JIRA status names (see
[config.md](config.md#trackertransition) for GitHub). Its skills (`grilling`,
`to-spec`, `implement`, `code-review` and so on) must be installed for the
Runner.
