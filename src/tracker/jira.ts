import { runTool, failureReason, parseJson } from "./exec.ts";
import { adfToText } from "./adf.ts";
import { TrackerError, type Issue, type LabelChange, type Tracker } from "./tracker.ts";

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

  async transition(reference: string, status: string): Promise<void> {
    const r = await runTool("acli", ["jira", "workitem", "transition", "--key", reference, "--status", status, "--yes"]);
    if (r.code !== 0) throw new TrackerError(`${reference}: ${failureReason("acli", r)}`);
  }

  async labels(reference: string): Promise<string[]> {
    const r = await runTool("acli", ["jira", "workitem", "view", reference, "--fields", "labels", "--json"]);
    if (r.code !== 0) throw new TrackerError(`${reference}: ${failureReason("acli", r)}`);
    const parsed = parseJson<{ fields?: { labels?: unknown } }>("acli", reference, r.stdout, (m) => new TrackerError(m));
    const labels = parsed.fields?.labels;
    return Array.isArray(labels) ? labels.map(String) : [];
  }

  /** acli adds with --labels and removes with --remove-labels; the rest of the set is untouched. */
  async editLabels(reference: string, { add, remove }: LabelChange): Promise<void> {
    const args = ["jira", "workitem", "edit", "--key", reference];
    if (add.length) args.push("--labels", add.join(","));
    if (remove.length) args.push("--remove-labels", remove.join(","));
    const r = await runTool("acli", [...args, "--yes"]);
    if (r.code !== 0) throw new TrackerError(`${reference}: ${failureReason("acli", r)}`);
  }

  async checkStatus(status: string): Promise<string | null> {
    const jql = `project = ${this.project} AND status = "${status.replace(/"/g, '\\"')}"`;
    const r = await runTool("acli", ["jira", "workitem", "search", "--jql", jql, "--limit", "1", "--json"]);
    return r.code === 0 ? null : failureReason("acli", r);
  }
}
