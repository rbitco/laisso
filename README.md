# Lasso

Lasso drives a Ticket through a Pipeline of Stages using a coding-agent Runner
(Claude Code, Codex, or Pi), keeps Ticket state in its own store mirrored to the
tracker, and shows every Ticket on a local dashboard. The spec is
`docs/spec/lasso-v1.md`; the glossary is `CONTEXT.md`; decisions are in `docs/adr`.

## Run

Node 24 or later (the code runs as TypeScript directly; nothing is compiled).

```sh
pnpm install
pnpm start            # starts lasso on http://localhost:7433
pnpm start -- status  # the ledger, as a client of the running process
```

Everything Lasso owns lives under `~/.lasso` (`LASSO_HOME` overrides it):
`config.yaml`, `pipelines/`, `tickets/`, `lasso.db`, `lasso.log`, `lasso.pid`.
The first run writes a commented `config.yaml` and the default Pipeline and
never touches either again.

## Test

```sh
pnpm typecheck
pnpm test
```

Tests drive the localhost JSON API end to end against a temporary Lasso home,
with fake executables on `PATH` standing in for anything outside the process
(so far the notifier; the Runner and the `gh` and `acli` shims arrive with the
slices that need them). See `test/harness.ts`.
