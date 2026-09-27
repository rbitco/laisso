import { runTool, failureReason, parseJson } from "./exec.ts";
import { adfToText } from "./adf.ts";
import { TrackerError, type Issue, type Tracker } from "./tracker.ts";

/** JIRA through the acli CLI. `project` is the project key. */
export class JiraTracker implements Tracker {
  project: string;

  constructor(project: string) {
    this.project = project;
  }

  branchKey(reference: string): string {
    return reference;
  }

  async fetchIssue(reference: string): Promise<Issue> {
    const r = await runTool("acli", ["jira", "workitem", "view", reference, "--fields", "summary,description", "--json"]);
    if (r.code !== 0) throw new TrackerError(`${reference}: ${failureReason("acli", r)}`);
    const parsed = parseJson<{ fields?: { summary?: unknown; description?: unknown } }>("acli", reference, r.stdout, (m) => new TrackerError(m));
    const fields = parsed.fields ?? {};
    const title = typeof fields.summary === "string" ? fields.summary.trim() : "";
    if (!title) throw new TrackerError(`${reference}: acli returned no summary`);
    const description = fields.description;
    const body = typeof description === "string" ? description : description ? adfToText(description) : null;
    return { reference, title, body: body || null };
  }

  async checkStatus(status: string): Promise<string | null> {
    const jql = `project = ${this.project} AND status = "${status.replace(/"/g, '\\"')}"`;
    const r = await runTool("acli", ["jira", "workitem", "search", "--jql", jql, "--limit", "1", "--json"]);
    return r.code === 0 ? null : failureReason("acli", r);
  }
}
