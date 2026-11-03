import path from "node:path";
import type { LaissoHome } from "../server/home.ts";

/** Where `laisso setup` points its agent: the home it sets up and the skills shipped with this Laisso. */
export interface SetupContext {
  home: LaissoHome;
  /** The skills in this package, whose laisso-setup walkthrough and laisso docs match the Laisso running setup. */
  skillsDir: string;
  /** The port config.yaml gives Laisso, for the dashboard URL. */
  port: number;
}

/**
 * The prompt `laisso setup` opens a Runner on: a pointer to the laisso-setup skill, which holds the walkthrough, so the
 * person sees a short request rather than the whole script. The skill's path is given too, for a Runner that has no
 * installed copy (Pi), and it reads the laisso docs beside it.
 */
export function setupPrompt({ home, skillsDir, port }: SetupContext): string {
  const skill = path.join(skillsDir, "laisso-setup", "SKILL.md");
  return `Set up Laisso with me using the laisso-setup skill (${skill}). Laisso's home is ${home.root}, and its dashboard is at http://localhost:${port}.`;
}
