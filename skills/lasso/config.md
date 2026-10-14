# config.yaml

`<Lasso home>/config.yaml`. Lasso writes a commented one on first start and
never rewrites it, except for the start-up move described under
[tracker.transition](#trackertransition). Every key is optional; a key left
out takes its default. A key that is present with a wrong value stops Lasso
from starting and makes `lasso doctor` exit 1 with a message naming the key.
Unknown top-level keys are ignored.

| Key | Default | Rule |
| --- | --- | --- |
| `repos` | `{}` | see [Repos](#repos) |
| `actions` | `{}` | see [Actions](#actions) |
| `profiles` | `claude-fable`, `claude-opus`, `claude-sonnet` | see [profiles.md](profiles.md); leaving the key out entirely brings back these three |
| `default_profile` | `claude-opus` | a profile name, or `null` for none |
| `budget.rounds` | `5` | whole number, 0 or more: Rounds per repeating Stage |
| `budget.attempts` | `2` | whole number, 0 or more: attempts per Stage |
| `budget.wallTime` | `30m` | duration: wall time per headless Session |
| `budget.spend` | `25` | number, 0 or more: agent spend per Ticket, USD |
| `tick` | `60` | whole number, 1 or more: seconds between Ticks |
| `concurrency` | `3` | whole number, 1 or more: headless Sessions at once across all Tickets |
| `retention` | `30` | whole number, 0 or more: days a done or Abandoned Ticket's directory is kept |
| `branch_prefix` | `""` | text; `me` makes branches `me/<key>-<slug>` |
| `port` | `7433` | whole number, 1 or more: dashboard and API port |
| `terminal` | `auto` | `auto`, `herdr`, `tmux` or `terminal-app`: where a human Stage's terminal opens; see [Terminals](#terminals) |
| `notifications.enabled` / `.flagged` / `.human` / `.gate` | all `true` | `true` or `false` |

A duration is hours, minutes and seconds in that order, each optional:
`30m`, `90s`, `2h`, `1h30m`. Names (profiles, Actions) are lowercase
letters, digits, dots, hyphens and underscores, starting with a letter or
digit.

```yaml lasso-config
budget:
  rounds: 8
  attempts: 3
  wallTime: 45m
  spend: 40
concurrency: 2
branch_prefix: matt
notifications:
  enabled: true
  gate: false
```

## Repos

A repo is where Intake makes Tickets' worktrees. Keyed by a short name the
user picks; that name is what `lasso add --repo` and the dashboard show.

| Field | Rule |
| --- | --- |
| `tracker` | `jira` or `github`. Anything else, or leaving it out, is read as `jira` without an error. |
| `project` | JIRA: the project key (`SHOP`). GitHub: `owner/repo`. Intake suggests this repo for a reference that starts `SHOP-` or `owner/repo#`. |
| `path` | the local clone. `~/` is expanded. Worktrees are made from its `origin`. |
| `pipeline` | the repo's default Pipeline, by file name without `.yaml`. Default `default`; a name with no file falls back to `default`, else the first Pipeline. |
| `actions` | this repo's own Actions; one named like a global Action replaces it for this repo's Tickets |
| `profiles` | this repo's own Agent Profiles; see [profiles.md](profiles.md#per-repo-profiles) |
| `default_profile` | the profile this repo's Stages run under when neither Stage nor Pipeline names one |

The repo needs its tracker CLI installed and logged in: `acli` for JIRA,
`gh` for GitHub (`lasso doctor` checks both). A JIRA key can only be intaken
into a JIRA repo and a GitHub reference only into a GitHub repo; a prompt
goes into any repo.

```yaml lasso-config
repos:
  shop:
    tracker: jira
    project: SHOP
    path: ~/code/shop
    pipeline: default
  web:
    tracker: github
    project: acme/web
    path: ~/code/web
    pipeline: github
    default_profile: claude-sonnet
```

## Actions

An Action is a shell command an action Stage runs by name. Global ones sit
under top-level `actions:`; a repo's own under `repos.<name>.actions:` and
win for that repo.

| Field | Rule |
| --- | --- |
| `run` | required, non-empty: the command, run with `$SHELL -c` (else `/bin/sh`) in the Ticket's worktree |
| `params` | optional list of names (lowercase letters, digits, underscores, starting with a letter), no repeats. A Stage must supply exactly these under `with:`. |
| `timeout` | optional duration, default `5m`; the command is killed and the Ticket Flagged after it |

Any other field is an error. Exit 0 advances the Ticket; anything else, a
timeout, or a command that cannot start Flags it `outcome.failed` with the
last line of output. The last line of output is the Session's final message.

The command's environment is Lasso's own plus:

- `LASSO_TICKET`, `LASSO_REFERENCE` (empty for a prompt Ticket with no issue
  yet), `LASSO_REPO`, `LASSO_BRANCH`, `LASSO_STAGE`, `LASSO_SESSION`
- `LASSO_TITLE`, `LASSO_TRACKER`, `LASSO_PROJECT`, `LASSO_PR` (empty before
  a PR), `LASSO_WORKTREE`, `LASSO_PIPELINE`
- one `LASSO_<PARAM>` per param, upper-cased: `params: [status]` gives
  `LASSO_STATUS`

Use these variables in `run`; Lasso does no template substitution, so
quoting stays the shell's job.

```yaml lasso-config
actions:
  notify:
    params: [channel]
    timeout: 1m
    run: echo "$LASSO_REFERENCE is at $LASSO_STAGE" >> ~/lasso-$LASSO_CHANNEL.log
```

### tracker.transition

The default Pipeline moves the tracker issue with an Action named
`tracker.transition` taking `status`. It is an ordinary Action, but Lasso
writes it for you: at every start, if `config.yaml` has no **global**
`actions.tracker.transition`, Lasso adds the JIRA one below globally and the
GitHub one to each `github` repo that lacks its own. Once a global one
exists Lasso never touches this again, so a GitHub repo added later gets no
override: add it by hand.

JIRA, the global one Lasso writes:

```yaml lasso-config
actions:
  tracker.transition:
    params: [status]
    run: |
      [ -n "$LASSO_REFERENCE" ] || { echo "$LASSO_STAGE: the Ticket has no tracker issue yet" >&2; exit 1; }
      acli jira workitem transition --key "$LASSO_REFERENCE" --status "$LASSO_STATUS" --yes >&2 || exit $?
      echo "moved $LASSO_REFERENCE to $LASSO_STATUS"
```

GitHub, the per-repo override Lasso writes. A GitHub issue is only open or
closed, so this accepts `status` `open` or `closed` (any case) and fails on
anything else. The default Pipeline's `In Progress`, `In Review` and `Done`
therefore Flag a GitHub Ticket: give GitHub repos a Pipeline whose
transitions use `open`/`closed`, or none (see
[examples/github/](examples/github/)).

```yaml lasso-config
repos:
  web:
    tracker: github
    project: acme/web
    path: ~/code/web
    actions:
      tracker.transition:
        params: [status]
        run: |
          [ -n "$LASSO_REFERENCE" ] || { echo "$LASSO_STAGE: the Ticket has no tracker issue yet" >&2; exit 1; }
          case "$(printf %s "$LASSO_STATUS" | tr '[:upper:]' '[:lower:]')" in
            closed) verb=close ;;
            open) verb=reopen ;;
            *) echo "GitHub accepts only open and closed, not $LASSO_STATUS" >&2; exit 1 ;;
          esac
          gh issue "$verb" "${LASSO_REFERENCE##*#}" --repo "${LASSO_REFERENCE%#*}" >&2 || exit $?
          echo "moved $LASSO_REFERENCE to $LASSO_STATUS"
```

On a machine with only GitHub repos, put the GitHub command in the global
`tracker.transition` instead: Lasso then adds nothing, and `acli` is not
needed (doctor lists a tool as needed when any Action's `run` names it).

## Terminals

Open terminal on a human Stage runs the Runner in a new terminal, in the
Ticket's worktree, named like `Lasso: LASSO-42 grill`. Where it opens:

| `terminal` | Opens |
| --- | --- |
| `auto` | a herdr tab when Lasso was started inside herdr (`HERDR_ENV=1`), else a tmux window when it was started inside tmux (`TMUX` set), else a Terminal.app window |
| `herdr` | a new tab in Lasso's herdr workspace, focused |
| `tmux` | a new window in Lasso's tmux session, which becomes its current window |
| `terminal-app` | a Terminal.app window, brought to the front |

The window opens where the `lasso` process runs, not where the browser
is. Under `auto`, a herdr or tmux that fails (its server gone since Lasso
started) falls back to Terminal.app and logs `terminal.fallback`; a
terminal named outright that fails is an error on Open terminal instead,
and `lasso doctor` lists it as a needed tool. `lasso doctor` ends with
where human Stages open, as Lasso started from that shell would choose.

## When edits apply

| Edit | Applies |
| --- | --- |
| `actions`, `profiles`, `default_profile` (global or a repo's), `terminal` | at the next Session or action Stage that starts; no restart |
| `concurrency` | at the next Tick |
| Pipeline files | at the next Intake; Tickets already under way keep their Version |
| `repos` (added, removed, or changed `tracker`/`project`/`path`/`pipeline`), `budget`, `retention`, `branch_prefix`, `notifications` | after a restart, or after the next save from the dashboard's Config page, which rereads the whole file |
| `port`, `tick` | after a restart only |

Restart means stopping the foreground `lasso` process (Ctrl-C) and starting
it again. Ctrl-C stops running headless Sessions; they are rerun on the next
start without counting as an attempt. Human (terminal) Sessions are left
alone.
