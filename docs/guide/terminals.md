# Terminals and Take over

## Where human Stages open

Open terminal on a human Stage runs the Runner in a new terminal named for
the Ticket and Stage. `terminal:` in `config.yaml` says where:

- `auto` (the default): a herdr tab when Laisso was started inside herdr, a
  tmux window when inside tmux, and a Terminal.app window otherwise.
- `herdr`, `tmux` or `terminal-app`: that one, always.

The window opens beside the `laisso` process, not the browser. Under `auto`,
a herdr or tmux that fails falls back to Terminal.app and logs why; a named
one that fails is reported on Open terminal. `laisso doctor` says which
applies.

## Take over in terminal

Take over in terminal steps into any headless Stage, running or Flagged.
Laisso stops the Session (a Flag clears) and opens its Runner session in a
terminal. The Stage is then worked as a human Stage until Mark done, Skip,
Abandon or Hand back.

Hand back ends the terminal Session and gives the Stage back to Laisso
without spending an attempt. A Review Stage polls the PR at once and opens a
Round for any Feedback that arrived meanwhile; any other Stage starts a
headless Session that re-enters the terminal's Runner session.

## Approval steps

For an approval step, give the drafting Stage `advance: false`, as the
default Pipeline's plan Stage has. While the Ticket holds, Open <Stage> in
terminal re-enters the finished draft without changing anything, and Start
releases the next Stage.

## Ticket names

A Ticket may be given a name, in the Import Ticket dialog or later with Name
or Rename on its page. The name then shows in place of its reference or
short id in the dashboard, `laisso status`, notifications and terminal
window names. Branches and URLs keep the id, and the tracker never sees it.
