import { existsSync } from "node:fs";
import path from "node:path";
import { Git } from "../git.ts";
import { actionArtifact, fileArtifact } from "../pipeline/load.ts";

export interface ArtifactVerdict {
  present: boolean;
  /** Why it is missing, in words a Flag can carry. */
  detail: string | null;
  /** The check itself broke (a check Action exited other than 0 or 1, timed out, or could not start): not "missing" but "cannot tell". */
  broken?: boolean;
}

/** Runs a check Action (ADR 0014) for the Ticket: exit 0 present, 1 missing, anything else broken. */
export type ActionProbe = (action: string, params: Record<string, string>) => Promise<ArtifactVerdict>;

const NO_ACTIONS: ActionProbe = async (action) => ({ present: false, detail: `${action} cannot be run here`, broken: true });

/** One Owned PR as the pr-* artifacts need it. */
export interface OwnedPr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewed: boolean;
}

/** The Ticket's Owned PRs, read on demand; empty when it has none. Referenced PRs never count. */
export type PrProbe = () => Promise<OwnedPr[]>;

const NO_PR: PrProbe = async () => [];

/** "PR #12, #15": the PRs a pr-* message names. */
function named(prs: OwnedPr[]): string {
  return `PR ${prs.map((p) => `#${p.number}`).join(", ")}`;
}

/** The pr-* artifacts over every Owned PR: pr-exists needs one, pr-review a review on each open one, pr-merged every one merged. */
function judgePrs(artifact: "pr-exists" | "pr-review" | "pr-merged", owned: OwnedPr[]): ArtifactVerdict {
  if (!owned.length) return { present: false, detail: "no Owned PR for the Ticket" };
  if (artifact === "pr-exists") return { present: true, detail: null };
  const short = artifact === "pr-review" ? owned.filter((p) => p.state === "OPEN" && !p.reviewed) : owned.filter((p) => p.state !== "MERGED");
  if (!short.length) return { present: true, detail: null };
  return { present: false, detail: artifact === "pr-review" ? `nobody has reviewed ${named(short)}` : `${named(short)} not merged` };
}

/**
 * Is the Stage's declared artifact there? Laisso decides done from this and
 * the Outcome, never from Stage-specific signals (ADR 0002). The tracker
 * artifacts arrive with the slice that owns that integration.
 */
export async function checkArtifact(artifact: string | null, worktree: string, pr: PrProbe = NO_PR, check: ActionProbe = NO_ACTIONS, params: Record<string, string> = {}): Promise<ArtifactVerdict> {
  if (artifact === null) return { present: true, detail: null };
  const action = actionArtifact(artifact);
  if (action !== null) return check(action, params);
  if (artifact === "pr-exists" || artifact === "pr-review" || artifact === "pr-merged") {
    return judgePrs(artifact, await pr());
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
