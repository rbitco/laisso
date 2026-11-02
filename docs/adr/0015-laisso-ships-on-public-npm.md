---
status: accepted
---

# Laisso ships on public npm as `laisso`

Laisso is open source under MIT, so it needs a channel anyone can install
from. It is published to the public npm registry as the unscoped `laisso`.

## Considered Options

- A scoped `@rbitco/laisso` on npmjs: needs an `rbitco` scope there, and a
  machine that maps `@rbitco` to another registry would never see it.
- A private self-hosted registry: installs only work where that registry
  can be reached, which rules out anyone else.

## Consequences

- `npm i -g laisso` works anywhere with no registry setup.
- `publishConfig.registry` names npmjs, and the release workflow publishes
  with an `NPMJS_TOKEN` secret, a granular token that may publish
  `laisso`.
- The tarball is `laisso-<version>.tgz`.
- The release job runs on a GitHub-hosted runner.
