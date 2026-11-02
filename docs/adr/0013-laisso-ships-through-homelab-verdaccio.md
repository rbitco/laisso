---
status: accepted
---

# Laisso ships through a homelab Verdaccio registry

Laisso is installed only on Matt's own machines, so it needs a private
channel. Research compared self-hosted Verdaccio, tarballs on a homelab
web server, GitHub Packages, a private Homebrew tap, and installing from a
git URL, and recommended GitHub Packages (research on
`research/distribution-channels`, LASSO-85). We chose Verdaccio on the
homelab instead, at `https://npm.matty.rocks`, with
`http://10.30.0.61:4873` through portproxy for machines without local DNS.
GitHub Packages accepts only classic personal access tokens, so every
machine would need a long-lived GitHub token in `~/.npmrc`, and installs
would depend on GitHub. Verdaccio lets any LAN machine install without a
token and keeps the package entirely on hardware Matt runs.

## Considered Options

- GitHub Packages: works away from home and publishes from GitHub-hosted
  CI with `GITHUB_TOKEN`, but costs a classic `read:packages` token on
  every machine.
- Tarballs on a web server, or `npm i -g` from a git URL: no registry to
  run, but `npm update -g` resolves by package name, so upgrades fail or,
  for an unscoped `laisso`, silently install the unrelated public `laisso`.
  Git installs also build on every machine.
- Private Homebrew tap: `brew upgrade` works, but each release needs a
  formula edit.

## Consequences

- Installs and upgrades work only on the home LAN. A machine away from
  home keeps the version it has.
- GitHub-hosted runners cannot reach the registry, so publishing is done
  from somewhere on the LAN (LASSO-88 decides where).
- The package is `@rbitco/laisso` with `private` removed and
  `publishConfig.registry` set to Verdaccio, so a stray `npm publish`
  never reaches npmjs. Machines map only the `@rbitco` scope to
  Verdaccio; every other package still comes from npmjs, so a homelab
  outage blocks only Laisso.
- Verdaccio runs as a K3s app in the homelab repo. `@rbitco/*` is not
  proxied upstream, anyone on the LAN can read it, publishing needs a
  login, and self-registration is off.
