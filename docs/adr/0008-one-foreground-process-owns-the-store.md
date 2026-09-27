---
status: accepted
---

# One foreground process owns the store; everything else is a client

Notifications and the scheduler tick both assume something is running
while the dashboard tab is closed. We could have installed a launchd
user agent, started a background process on demand from whatever
command ran first, or let each CLI command open the SQLite store for
itself. We decided instead that `lasso` is a single foreground process
you leave running in a terminal: it serves the dashboard on a fixed
localhost port, runs the tick, spawns headless Sessions as its own
children, sends notifications, and is the only process that opens the
store. Every other `lasso <subcommand>`, including a CLI intake, is a
thin client over localhost HTTP that fails with "lasso is not running"
when the port is dead. A pid file under `~/.lasso`, held under an
exclusive lock, makes a second `lasso` refuse to start and print the URL
of the one already running. Lasso is solo tooling on one laptop, and a
process you can see, stop, and read the stdout of beats an always-on
agent hidden behind launchd; one writer on SQLite and one place that
validates intake beats a CLI that can race the server.

## Consequences

- When `lasso` is not running, Lasso is off: no tick, no notifications,
  dead dashboard URL, and intake refuses. Nothing is written to
  launchd or systemd.
- Headless Sessions die with `lasso`. On Ctrl-C each is stopped by
  process group and its Outcome recorded as interrupted with reason
  `shutdown`. Partial work in that Session is lost; the next tick
  starts a fresh Session for the Stage.
- An interruption with reason `shutdown` does not count toward the
  attempts-per-Stage Budget, so restarting `lasso` can never Flag a
  Ticket on its own. Wall time and spend still count what was used.
- On startup, before the first tick, Lasso reconciles Session rows
  still marked running: a headless row whose pid is alive is killed by
  process group and recorded as interrupted with reason `shutdown`; a
  terminal Session, which outlives `lasso`, is checked with the
  adapter's `findSession`, kept live if still running, and otherwise
  closed from the Runner's own transcript. The first tick then runs at
  once rather than after the cadence.
- The port is a flag and a `config.yaml` key; the dashboard URL is
  stable enough to bookmark.
- Lasso logs one line per event to stdout and to `~/.lasso/lasso.log`,
  rotated by size. Session transcripts stay in their per-Ticket
  directories. Earlier decisions that say "log only" mean this log.
- The CLI's subcommands and the localhost API they share are a later
  decision; this ADR fixes only that they go through the running
  process.
