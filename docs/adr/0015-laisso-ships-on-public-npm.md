---
status: accepted
---

# Laisso ships on public npm as `laisso`

Laisso is now open source under MIT, so it needs a channel anyone can
install from. It is published to the public npm registry as the unscoped
`laisso`, replacing the homelab Verdaccio of ADR 0013.

## Considered Options

- Keep `@rbitco/laisso` and publish it to npmjs: needs an `rbitco` scope on
  npmjs, and machines already map `@rbitco` to Verdaccio, so they would keep
  installing from the homelab instead.
- Keep Verdaccio: installs only work on the home LAN, which rules out
  anyone else.

## Consequences

- `npm i -g laisso` works anywhere with no registry setup.
- `publishConfig.registry` names npmjs, and the release workflow publishes
  with an `NPMJS_TOKEN` secret, a granular token that may publish
  `laisso`.
- The upgrade notice and `npm view` ask about `laisso`, so an install of
  `@rbitco/laisso` sees no newer release: switch with
  `npm uninstall -g @rbitco/laisso && npm i -g laisso`.
- The tarball is `laisso-<version>.tgz`.
- The release job runs on a GitHub-hosted runner: npmjs needs no LAN
  access, and a public repo stays off the shared self-hosted runner.
