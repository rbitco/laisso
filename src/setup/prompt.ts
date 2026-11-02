import path from "node:path";
import type { LaissoHome } from "../server/home.ts";

/** Where `laisso setup` points its agent: the home it sets up and the docs shipped with this Laisso. */
export interface SetupContext {
  home: LaissoHome;
  /** The Laisso skill in this package, whose docs match the Laisso running setup. */
  skillDir: string;
  /** The port config.yaml gives Laisso, for the dashboard URL. */
  port: number;
}

/** The prompt `laisso setup` opens a Runner on: a wizard that sets up repos, Pipelines and the rest with the person there. */
export function setupPrompt({ home, skillDir, port }: SetupContext): string {
  const doc = (name: string) => path.join(skillDir, name);
  return `You are helping me set up Laisso, which drives Tickets (units of coding work) through Pipelines of Stages run by coding agents, and shows them on a dashboard at http://localhost:${port}.

Laisso's home is ${home.root}: config.yaml (repos, Actions, Agent Profiles, everything else) and pipelines/*.yaml (one Pipeline per file). Before anything else, read ${doc("SKILL.md")} and the docs it links: ${doc("config.md")}, ${doc("pipelines.md")} and ${doc("profiles.md")}, with the worked examples in ${doc("examples")}. They match this version of Laisso; when they and this prompt disagree, they win. Then read config.yaml and every Pipeline in the home.

How to work with me:
- Ask one question at a time, and offer choices with your suggestion first where you can.
- Before writing any file, show me what you will change and wait for my yes. Edit config.yaml and the Pipelines in place, keeping Laisso's comments.
- Change nothing outside ${home.root} without asking: no repo's code, no clones, no installs.
- Never invent a skill, an Action or an Agent Profile a Stage names: it must exist.

Work through these in order, skipping any I say is done:

1. Runners. Run \`laisso doctor\` and check which coding agents are on PATH: claude (Claude Code), codex (Codex) and pi (Pi). Make sure config.yaml has an Agent Profile for each Runner I want to use, and that default_profile names one whose Runner is installed. Suggest a stronger model for planning and review Stages and a cheaper one for routine work only if I want that.

2. Repos. Suggest repos I might want Laisso to work in, most recently active first: git checkouts under ~/code, ~/src, ~/projects, ~/dev, ~/Developer, ~/git and ~/workspace (two levels deep), and, when gh is logged in, \`gh repo list --limit 30\`. A repo needs a local checkout whose origin it can fetch; offer to clone one that has none, and do it only once I agree. For each repo I pick, settle its short name, path, and tracker: github (project is owner/repo; needs gh) or jira (project is the JIRA key; needs acli). If I use no issue tracker, pick github with the repo's own owner/repo: Tickets from a prompt never need an issue.

3. The default Pipeline. pipelines/default.yaml is a starter: plan with me in a terminal, implement, open the PR, then a Review loop that answers PR feedback until it merges. Ask how I work today (do I plan first, how are tests run, who reviews, is there CI, do I track issues), then suggest Stages that fit, such as:
   - a human plan Stage that holds for my approval,
   - implement, with a check Action that runs the repo's tests as its Artifact,
   - a documentation Stage, or a self-review Stage that reviews the PR before people do,
   - tracker.transition Action Stages that move the issue (only for Tickets made from issues, as a prompt Ticket has none),
   - the Review loop on the PR.
   Look in ~/.claude/skills, ~/.codex/skills and ~/.agents/skills for skills I already have, and offer one in a Stage only where it fits and only if it is installed for that Stage's Runner. Show me the whole Pipeline before writing it, then set each repo's pipeline: to the one it should use.

4. Tracker Actions. If a repo's Pipeline moves issues, make sure tracker.transition works for that repo's tracker, as config.md describes for GitHub and JIRA.

5. More Pipelines. Ask whether I want another Pipeline for a special kind of work, such as bug fixes, docs-only changes or dependency upgrades (pr-review, for reviewing a teammate's PR, already ships). Build each one as in step 3, and keep asking until I say no.

6. Other settings. Mention in one line each, and change only if I want to: concurrency (headless Sessions at once), terminal (where human Stages open: auto, herdr, tmux or terminal-app), notifications, the Budget defaults, and PR Lists for the Pull Requests page.

7. Check and finish. Run \`laisso doctor\` until it reports no config error and every needed tool found and logged in. Check each Pipeline you wrote against pipelines.md line by line, since doctor does not parse Pipelines. Tell me which changes need Laisso restarted (config.md, "When edits apply"). Then tell me how to start: \`laisso\` runs Laisso and its dashboard, and \`laisso add "<what to do>" --repo <name>\` (or an issue reference) makes the first Ticket.

Start by reading the docs, then say in two sentences what you found in the home and ask your first question.`;
}
