# The Review loop

A Stage with `repeat: feedback` is the Review loop. The default Pipeline's
last Stage, review, is one.

## Polling the PR

Each tick Laisso polls the Ticket's PR through `gh`: comments, review
threads, check runs on the head commit, and the review decision. It uses
ETags, so an unchanged PR costs nothing against the rate limit.

## Rounds

New Feedback opens a Round: a Session whose prompt carries a snapshot of
what to address, and a marker (`<!-- laisso:<ticket>:<stage>:round-<n> -->`)
the Runner ends each of its PR comments with, so its own replies are never
taken for Feedback.

When the Round ends, Laisso records how each item was addressed (a resolved
thread, a marked reply, a new push) and Flags:

- `review.unaddressed` for what still stands,
- `review.check_repeat` when the same check fails two Rounds running,
- `review.pr_closed` when the PR closes unmerged.

A merged PR finishes the Stage. Green checks with nothing outstanding show
as quiet.

## Commenting without starting a Round

To comment on your own PR without starting a Round, list logins under
`review.ignore_authors`, or set `review.ignore_self: true` to ignore the
login `gh` is authenticated as. A repo may set either under
`repos.<name>.review`.

Their PR comments, and threads no one else has joined, are never Feedback. A
thread someone else has joined still is, and its Round reads every comment
in it. Failed checks and a changes-requested verdict count whoever is
involved.

## Checking now

`laisso check` and the dashboard header's Check now run a tick and report
what changed. The dot left of Check now pulses while a tick runs and turns
red while the dashboard can't reach Laisso; hover it for when the last tick
ran and the next is due.
