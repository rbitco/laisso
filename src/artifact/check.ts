import { existsSync } from "node:fs";
import path from "node:path";
import { Git } from "../git.ts";
import { fileArtifact } from "../pipeline/load.ts";

export interface ArtifactVerdict {
  present: boolean;
  /** Why it is missing, in words a Flag can carry. */
  detail: string | null;
}

/**
 * Is the Stage's declared artifact there? Lasso decides done from this and
 * the Outcome, never from Stage-specific signals (ADR 0002). The tracker and
 * PR artifacts arrive with the slices that own those integrations.
 */
export async function checkArtifact(artifact: string | null, worktree: string): Promise<ArtifactVerdict> {
  if (artifact === null) return { present: true, detail: null };
  const file = fileArtifact(artifact);
  if (file !== null) {
    return existsSync(path.join(worktree, file)) ? { present: true, detail: null } : { present: false, detail: `${file} does not exist in the worktree` };
  }
  if (artifact === "commits-on-branch") {
    const git = new Git(worktree);
    const base = await git.defaultBranch();
    const count = Number(await git.exec(["rev-list", "--count", `origin/${base}..HEAD`]));
    return count > 0 ? { present: true, detail: null } : { present: false, detail: `no commits on the branch beyond origin/${base}` };
  }
  return { present: false, detail: `${artifact} cannot be checked yet` };
}
