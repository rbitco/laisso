import { existsSync } from "node:fs";
import path from "node:path";
import { Git } from "../git.ts";
import { fileArtifact } from "../pipeline/load.ts";

export interface ArtifactVerdict {
  present: boolean;
  /** Why it is missing, in words a Flag can carry. */
  detail: string | null;
}

/** The Ticket's PR as the pr-* artifacts need it, read on demand; null when the branch has none. */
export type PrProbe = () => Promise<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; reviewed: boolean } | null>;

const NO_PR: PrProbe = async () => null;

/**
 * Is the Stage's declared artifact there? Lasso decides done from this and
 * the Outcome, never from Stage-specific signals (ADR 0002). The tracker
 * artifacts arrive with the slice that owns that integration.
 */
export async function checkArtifact(artifact: string | null, worktree: string, pr: PrProbe = NO_PR): Promise<ArtifactVerdict> {
  if (artifact === null) return { present: true, detail: null };
  if (artifact === "pr-exists" || artifact === "pr-review" || artifact === "pr-merged") {
    const found = await pr();
    if (!found) return { present: false, detail: "no PR for the branch" };
    if (artifact === "pr-exists") return { present: true, detail: null };
    if (artifact === "pr-review") return found.reviewed ? { present: true, detail: null } : { present: false, detail: `nobody has reviewed PR #${found.number}` };
    return found.state === "MERGED" ? { present: true, detail: null } : { present: false, detail: `PR #${found.number} is ${found.state.toLowerCase()}` };
  }
  const file = fileArtifact(artifact);
  if (file !== null) {
    return existsSync(path.join(worktree, file)) ? { present: true, detail: null } : { present: false, detail: `${file} does not exist in the worktree` };
  }
  if (artifact === "commits-on-branch") {
    try {
      const git = new Git(worktree);
      const base = await git.defaultBranch();
      const count = Number(await git.exec(["rev-list", "--count", `origin/${base}..HEAD`]));
      return count > 0 ? { present: true, detail: null } : { present: false, detail: `no commits on the branch beyond origin/${base}` };
    } catch (error) {
      return { present: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { present: false, detail: `${artifact} cannot be checked yet` };
}
