# Contributing

Laisso is TypeScript on Node 24 or later, and runs on macOS only (it opens
terminals through Terminal.app, tmux or herdr). The spec is
[docs/spec/laisso-v1.md](docs/spec/laisso-v1.md), the glossary is
[CONTEXT.md](CONTEXT.md), and decisions are in [docs/adr](docs/adr).

## Run from a clone

From a checkout the server runs as TypeScript directly; only the dashboard
is built, by Vite, into `dist/dashboard/` (ADR 0012). Laisso refuses to
start until it is built.

```sh
pnpm install
pnpm start               # builds the dashboard, then starts laisso on http://localhost:7434
pnpm start status        # the Ledger, as a client of the running process
pnpm start check         # run a tick now and print what changed
pnpm start setup         # any laisso command and options follow pnpm start
pnpm build               # build the dashboard alone
pnpm dev                 # serve the dashboard from source, forwarding /api to the dev laisso (port 7434)
```

A clone keeps out of an installed Laisso's way: `pnpm start` and `pnpm dev`
use the Laisso home `~/.laisso-dev` on port 7434, where an installed
`laisso` uses `~/.laisso` on 7433, so both can run at once. Set
`LAISSO_HOME` or `LAISSO_PORT` to override either, such as
`LAISSO_HOME=~/.laisso` to point dev at the real home on purpose.
`LAISSO_PORT` only sets the port in a new home's `config.yaml`; an existing
one keeps its `port:`.

A dev build (version `0.0.0-dev`) shows a "dev" badge in the dashboard
header and "(dev)" in the tab title, and `laisso status` starts with the
version and Laisso home that answered.

## Test

```sh
pnpm typecheck
pnpm test
```

Tests drive the localhost JSON API end to end against a temporary Laisso
home, with fake executables on `PATH` standing in for anything outside the
process: the notifier, the Runners, Terminal.app (`osascript`), tmux and
herdr, and `gh` and `acli` shims that answer from canned replies a test
seeds and record every invocation for it to assert on. See
[test/harness.ts](test/harness.ts).

## Package

The npm package ships prebuilt JavaScript, since Node will not run
TypeScript from `node_modules`. `npm pack` typechecks, builds the
dashboard, then bundles the CLI and server with esbuild into
`dist/laisso.js` (with a source map, so stack traces show `.ts` lines). The
tarball holds only `dist/` and `skills/`. To check one installs and serves:

```sh
npm pack
node scripts/smoke-test.ts <tarball> 0.0.0-dev
```

## Release

Tag main and push the tag:

```sh
git fetch origin
git tag vX.Y.Z origin/main && git push origin vX.Y.Z
```

`.github/workflows/release.yml` then runs the tests, sets the version from
the tag, packs, smoke-tests the tarball, publishes it and creates a GitHub
Release. package.json stays `0.0.0-dev` in git. A `vX.Y.Z-next.N` tag
publishes a preview under the `next` dist-tag.

## Pull requests

Keep a change to one concern, with tests that drive it the way a person
would (the API, the CLI or a dashboard component). Run `pnpm typecheck` and
`pnpm test` before opening the PR.
