/** The built-in Artifacts a Stage can name, beside `file <path>` and `action <name>`; kept apart from load.ts so the dashboard can list them. */
export const ARTIFACTS = ["tracker-spec", "tracker-comment", "commits-on-branch", "pr-exists", "pr-review", "pr-merged"] as const;
