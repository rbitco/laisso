# Shutdown, restart and end of life

## Ctrl-C and restart

Ctrl-C stops every running headless Session by process group and records
each as interrupted, with reason shutdown, before Laisso exits. Terminal
Sessions are left alone.

On the next start, before the first tick, any Session row still marked
running is reconciled the same way (a leftover process is killed and waited
out first). The first tick then runs at once, so queued Tickets and
interrupted runs and Rounds resume within seconds. Ctrl-C during that first
tick is honoured too.

A Session cut off by shutdown never counts as an attempt, and a Round cut
off is run again against its own attempts, not the previous Round's.

## Done

A Ticket's end of life is final (ADR 0007). Done, when the last Stage
completes or Mark done or Skip lands on it, removes the worktree and the
local branch and clears every `laisso:*` label. The tracker's status stays
where the Pipeline left it.

## Abandon

Abandon:

1. kills the Ticket's headless Sessions,
2. commits anything uncommitted as `wip: abandoned in Laisso`, and pushes it
   when the branch has a remote,
3. removes the worktree and keeps the branch,
4. closes the open Owned PRs you tick in its popover, each with a marked
   comment naming its head branch as kept.

Unticked, merged and Referenced PRs are left alone.

There is no Reopen: intaking the same issue again makes a new Ticket on the
kept branch.

## Cleanup

The per-Ticket directory under `~/.laisso/tickets/` outlives both until the
tick sweeps it `retention` days later (default 30). Store rows are never
swept. Done and Abandoned Tickets sit greyed behind the dashboard's "Show
done and Abandoned" toggle.
