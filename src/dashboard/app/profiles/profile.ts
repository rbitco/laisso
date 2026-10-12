import type { ProfileBlock, ProfileConfig } from "../../../server/config.ts";
import type { RunnerName } from "../../../pipeline/load.ts";
import { profileApplies } from "../../metro.js";

/** One set of model, effort, permission and args as typed: each field its raw text, blank when unset. */
export interface BlockDraft {
  model: string;
  effort: string;
  permission: string;
  args: string;
}

/** A profile in the drawer as typed: the shared block, the Codex-only skills_dir, and each mode's block. */
export interface Draft extends BlockDraft {
  runner: RunnerName;
  skills_dir: string;
  headless: BlockDraft;
  human: BlockDraft;
}

export type Mode = "headless" | "human";

function blockDraft(b: ProfileBlock = {}): BlockDraft {
  return { model: b.model ?? "", effort: b.effort ?? "", permission: b.permission ?? "", args: (b.args ?? []).join(" ") };
}

export function draftOf(p: ProfileConfig): Draft {
  return { runner: p.runner, ...blockDraft(p), skills_dir: p.skills_dir ?? "", headless: blockDraft(p.headless), human: blockDraft(p.human) };
}

/** A profile as the API takes it: blanks left out, and fields that do nothing on its Runner dropped. */
export function profileOf(d: Draft): ProfileConfig {
  const block = (b: BlockDraft): ProfileBlock => {
    const out: ProfileBlock = {};
    if (b.model.trim()) out.model = b.model.trim();
    if (b.effort) out.effort = b.effort as ProfileBlock["effort"];
    if (b.permission && profileApplies(d.runner, "permission")) out.permission = b.permission as ProfileBlock["permission"];
    const args = b.args.trim();
    if (args) out.args = args.split(/\s+/);
    return out;
  };
  const out: ProfileConfig = { runner: d.runner, ...block(d) };
  if (d.skills_dir.trim() && profileApplies(d.runner, "skills_dir")) out.skills_dir = d.skills_dir.trim();
  for (const mode of ["headless", "human"] as const) {
    const b = block(d[mode]);
    if (Object.keys(b).length) out[mode] = b;
  }
  return out;
}

/** True when the drawer holds a profile config.yaml does not, ignoring what saving would drop anyway. */
export function unsaved(saved: ProfileConfig | undefined, draft: Draft | null): boolean {
  if (!saved || !draft) return false;
  return JSON.stringify(profileOf(draftOf(saved))) !== JSON.stringify(profileOf(draft));
}
