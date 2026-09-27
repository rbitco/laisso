import { runTool, failureReason, parseJson } from "./exec.ts";
import { TrackerError, type Issue, type Tracker } from "./tracker.ts";

const STATUSES = ["open", "closed"];

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
    const m = /^(.+)#(\d+)$/.exec(reference);
    if (!m) throw new TrackerError(`${reference} is not owner/repo#n`);
    const r = await runTool("gh", ["issue", "view", m[2]!, "--repo", m[1]!, "--json", "title,body"]);
    if (r.code !== 0) throw new TrackerError(`${reference}: ${failureReason("gh", r)}`);
    const parsed = parseJson<{ title?: unknown; body?: unknown }>("gh", reference, r.stdout, (m) => new TrackerError(m));
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (!title) throw new TrackerError(`${reference}: gh returned no title`);
    return {
      reference,
      title,
      body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body : null,
    };
  }

  async checkStatus(status: string): Promise<string | null> {
    return STATUSES.includes(status.trim().toLowerCase()) ? null : `GitHub accepts only open and closed`;
  }
}
