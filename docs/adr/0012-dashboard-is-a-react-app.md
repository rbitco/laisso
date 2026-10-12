---
status: accepted
---

# The dashboard is a React app built with Vite

The dashboard was one static `index.html` whose script built every view
by hand from the JSON API. At about 1,900 lines it had no type checking,
so a change to the API's view types (`src/api/views.ts`) could break it
silently. Each view tracked its own redraws, unsaved edits, and stale
responses by hand, and a save rebuilt a whole panel, losing scroll,
focus, and open cards. Its tests could only grep the file for
`data-role` strings. We decided the dashboard becomes a React app in
TypeScript, bundled by Vite, that imports the API's view types directly.
This gives Lasso its first build step: until now Node ran every source
file as it stands.

## Considered Options

- Split the script into plain ES modules, no build: gives file
  boundaries but no types, and state stays hand-managed.
- Preact with `htm` templates, no build: gives components and state
  without a build step, but the templates are strings that TypeScript
  cannot check against the API's types.

## Consequences

- The dashboard moves view by view, not in one rewrite. React mounts into
  the existing page's sections, starting with Pipelines and Config, then
  the Ticket detail, then the Ledger. The old script is deleted once no
  view uses it.
- `metro.js` stays a pure module tested in Node and becomes TypeScript;
  React components call it rather than reimplementing it.
- `pnpm build` writes the bundle to `dist/dashboard/`, which is not
  committed. `pnpm start` builds first. If the bundle is missing, Lasso
  refuses to start and names the command to run, rather than serving a
  blank page. During development, Vite's dev server serves the dashboard
  and forwards `/api` to a running Lasso.
- The JSON API and its Server-Sent Events are unchanged; the dashboard
  stays one client of `/api` alongside the CLI.
- Dashboard tests render components with Testing Library in Vitest and
  assert on what a person sees, replacing checks for `data-role` strings.
