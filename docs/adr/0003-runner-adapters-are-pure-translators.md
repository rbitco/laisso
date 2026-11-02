---
status: accepted, amended by ADR 0011
---

# Runner adapters are pure translators; Laisso owns the process

Laisso must drive Claude Code, Codex, and Pi interchangeably per Stage, in
two modes: headless for agent-run Stages and in a terminal for
human-in-the-loop ones. We could have given each Runner adapter a `run`
and a `launch` operation that spawn the process and open the terminal
themselves. We decided instead that an adapter only translates: it
builds the command line for a request (`command`), turns captured stdout
into an Outcome (`parse`), and finds a Session's id after the fact where
the Runner assigns its own (`findSession`). Laisso spawns the process,
opens the terminal, creates the per-Ticket worktree, tees stdout into its
own store, and enforces wall time. Three side-effect-free adapters are
testable through their interface alone, terminal opening is one seam
instead of three, and the same Session flows through both modes.

## Consequences

- An adapter never touches the filesystem or a terminal; anything that
  does belongs in Laisso's core. The one exception is `findSession`, which
  reads only the Runner's own session index, and only for a Runner that
  names its sessions itself.
- Laisso reads the stdout it captured, never the Runner's own transcript
  files; their paths are kept only as pointers for humans.
- Runner-specific knobs (permission modes, sandboxes) are a fixed
  baseline inside each adapter, with an opaque per-Stage `runnerOptions`
  escape hatch. Laisso does not model permissions.
- Skill calls in a Pipeline are declared by name; the adapter emits the
  Runner's native invocation, so a Pipeline stays swappable per Runner.
- A Runner cannot ask for a human. Flagged is Laisso's verdict from the
  Outcome and the declared artifact, per ADR 0002.
