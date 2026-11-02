import { runTool, parseJson } from "./exec.ts";
import { TrackerError, trackerFailure, type Issue, type LabelChange, type Tracker } from "./tracker.ts";

const LABEL_COLOR = "5319E7";

function split(reference: string): { repo: string; number: string } {
  const m = /^(.+)#(\d+)$/.exec(reference);
  if (!m) throw new TrackerError(`${reference} is not owner/repo#n`);
  return { repo: m[1]!, number: m[2]! };
}

/** GitHub issues through the gh CLI. `project` is owner/repo. */
export class GithubTracker implements Tracker {
  project: string;

  constructor(project: string) {
    this.project = project;
  }

  branchKey(reference: string): string {
    return reference.replace(/[/#]/g, "-");
  }

  async fetchIssue(reference: string): Promise<Issue> {
    const { repo, number } = split(reference);
    const r = await runTool("gh", ["issue", "view", number, "--repo", repo, "--json", "title,body"]);
    if (r.code !== 0) throw trackerFailure("gh", reference, r);
    const parsed = parseJson<{ title?: unknown; body?: unknown }>("gh", reference, r.stdout, (m) => new TrackerError(m));
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (!title) throw new TrackerError(`${reference}: gh returned no title`);
    return {
      reference,
      title,
      body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body : null,
    };
  }

  async labels(reference: string): Promise<string[]> {
    const { repo, number } = split(reference);
    const r = await runTool("gh", ["issue", "view", number, "--repo", repo, "--json", "labels"]);
    if (r.code !== 0) throw trackerFailure("gh", reference, r);
    const parsed = parseJson<{ labels?: unknown }>("gh", reference, r.stdout, (m) => new TrackerError(m));
    return Array.isArray(parsed.labels) ? parsed.labels.map((l: { name?: unknown }) => String(l?.name ?? "")).filter(Boolean) : [];
  }

  /** A label GitHub does not know yet is created on first use, then the edit is tried once more. */
  async editLabels(reference: string, { add, remove }: LabelChange): Promise<void> {
    const { repo, number } = split(reference);
    const args = ["issue", "edit", number, "--repo", repo];
    if (add.length) args.push("--add-label", add.join(","));
    if (remove.length) args.push("--remove-label", remove.join(","));
    const first = await runTool("gh", args);
    if (first.code === 0) return;
    const missing = add.filter((label) => first.stderr.includes(`'${label}' not found`));
    if (!missing.length) throw trackerFailure("gh", reference, first);
    for (const label of missing) {
      const created = await runTool("gh", ["label", "create", label, "--repo", repo, "--color", LABEL_COLOR, "--description", "Set by Laisso", "--force"]);
      if (created.code !== 0) throw trackerFailure("gh", reference, created);
    }
    const again = await runTool("gh", args);
    if (again.code !== 0) throw trackerFailure("gh", reference, again);
  }
}
