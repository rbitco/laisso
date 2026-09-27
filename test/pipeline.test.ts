import { describe, it, expect } from "vitest";
import { parsePipeline, PipelineError } from "../src/pipeline/load.ts";

// Seam two, pure: every rule of the spec's Pipeline format, each with a
// failing case (LASSO-40), and one Pipeline that uses every field.
const STAGES = (body: string) => `runner: claude\nstages:\n${body}`;

const FAILING: Array<[string, string, RegExp]> = [
  ["an empty file", "", /is empty/],
  ["no stages", "runner: claude\n", /has no stages/],
  ["a stage that is not a mapping", STAGES("  - implement\n"), /stage 1 is not a mapping/],
  ["a stage with both action and prompt", STAGES("  - name: x\n    prompt: p\n    action: tracker.transition\n    status: Done\n"), /has both action and prompt\/skills/],
  ["a stage with neither prompt, skills nor action", STAGES("  - name: x\n    artifact: pr-exists\n"), /needs a prompt, skills, or an action/],
  ["an unknown action", STAGES("  - action: tracker.close\n"), /unknown action tracker\.close/],
  ["a transition without a status", STAGES("  - action: tracker.transition\n"), /tracker\.transition needs a status/],
  ["an action stage carrying Runner fields", STAGES("  - action: tracker.transition\n    status: Done\n    human: true\n"), /stage 1: human is not a field of an action Stage/],
  ["a stage without a name", STAGES("  - prompt: p\n"), /needs a name of lowercase letters, digits, and hyphens/],
  ["a name with spaces", STAGES("  - name: Do Work\n    prompt: p\n"), /needs a name of lowercase letters, digits, and hyphens/],
  ["two stages with one name", STAGES("  - name: x\n    prompt: p\n  - name: x\n    prompt: q\n"), /has two Stages named x/],
  ["an unknown artifact", STAGES("  - name: x\n    prompt: p\n    artifact: pr-approved\n"), /unknown artifact pr-approved/],
  ["a file artifact that escapes the worktree", STAGES("  - name: x\n    prompt: p\n    artifact: file ../etc/passwd\n"), /unknown artifact file \.\.\/etc\/passwd/],
  ["a repeat trigger other than feedback", STAGES("  - name: x\n    prompt: p\n    repeat: always\n"), /repeat must be feedback/],
  ["a repeating stage with no artifact to end it", STAGES("  - name: x\n    prompt: p\n    repeat: feedback\n"), /a repeating Stage needs an artifact/],
  ["two transitions to one status", STAGES("  - action: tracker.transition\n    status: Done\n  - action: tracker.transition\n    status: Done\n"), /has two Stages named transition-done/],
  ["an unknown Pipeline runner", "runner: gemini\nstages:\n  - name: x\n    prompt: p\n", /Pipeline p: unknown runner gemini/],
  ["an unknown Stage runner", STAGES("  - name: x\n    prompt: p\n    runner: gemini\n"), /stage 1: unknown runner gemini/],
  ["skills that are not strings", STAGES("  - name: x\n    skills: [1, 2]\n"), /skills must be a list of skill names/],
  ["skills that are not a list", STAGES("  - name: x\n    skills: grilling\n"), /skills must be a list of skill names/],
  ["a prompt that is not text", STAGES("  - name: x\n    prompt: [a]\n"), /prompt must be text/],
  ["human that is not a boolean", STAGES("  - name: x\n    prompt: p\n    human: yes please\n"), /human must be true or false/],
  ["advance that is not a boolean", STAGES("  - name: x\n    prompt: p\n    advance: 0\n"), /advance must be true or false/],
  ["a wall time that is not a duration", STAGES("  - name: x\n    prompt: p\n    budget: { wallTime: soon }\n"), /budget\.wallTime .*soon/],
  ["rounds that are not a whole number", STAGES("  - name: x\n    prompt: p\n    budget: { rounds: 1.5 }\n"), /budget\.rounds must be a whole number of 0 or more/],
  ["attempts that are negative", STAGES("  - name: x\n    prompt: p\n    budget: { attempts: -1 }\n"), /budget\.attempts must be a whole number of 0 or more/],
  ["a Stage budget with spend", STAGES("  - name: x\n    prompt: p\n    budget: { spend: 5 }\n"), /budget\.spend belongs to the Pipeline, not a Stage/],
  ["a Pipeline spend that is not a number", "budget: { spend: lots }\nstages:\n  - name: x\n    prompt: p\n", /budget\.spend must be a number of 0 or more USD/],
  ["a Pipeline budget with rounds", "budget: { rounds: 3 }\nstages:\n  - name: x\n    prompt: p\n", /budget\.rounds belongs to a Stage, not the Pipeline/],
  ["an unknown Stage field", STAGES("  - name: x\n    prompt: p\n    artefact: pr-exists\n"), /stage 1: unknown field artefact/],
  ["an unknown Pipeline field", "runer: claude\nstages:\n  - name: x\n    prompt: p\n", /Pipeline p: unknown field runer/],
  ["runnerOptions that are not a mapping", STAGES("  - name: x\n    prompt: p\n    runnerOptions: fast\n"), /runnerOptions must be a mapping/],
];

describe("parsePipeline refuses", () => {
  it.each(FAILING)("%s", (_what, yaml, message) => {
    expect(() => parsePipeline("p", yaml)).toThrow(PipelineError);
    expect(() => parsePipeline("p", yaml)).toThrow(message);
  });
});

describe("parsePipeline accepts", () => {
  it("every field of the format", () => {
    const pipeline = parsePipeline("full", `# a comment
runner: codex
budget:
  spend: 12.5
stages:
  - name: grill
    human: true
    advance: false
    skills: [grilling, to-spec]
    prompt: Talk.
    artifact: tracker-spec
    runner: claude
    runnerOptions: { model: opus }
    budget: { rounds: 1, attempts: 3, wallTime: 45m }
  - action: tracker.transition
    status: In Progress
  - name: review
    prompt: Address feedback.
    repeat: feedback
    artifact: pr-merged
  - name: notes
    prompt: Write.
    artifact: file docs/NOTES.md
`);
    expect(pipeline).toEqual({
      name: "full",
      runner: "codex",
      budget: { spend: 12.5 },
      stages: [
        { kind: "runner", name: "grill", prompt: "Talk.", skills: ["grilling", "to-spec"], runner: "claude", human: true, advance: false, artifact: "tracker-spec", repeat: null, budget: { rounds: 1, attempts: 3, wallTime: "45m" }, runnerOptions: { model: "opus" }, inheritsRunner: false },
        { kind: "action", name: "transition-in-progress", action: "tracker.transition", status: "In Progress" },
        { kind: "runner", name: "review", prompt: "Address feedback.", skills: [], runner: "codex", human: false, advance: true, artifact: "pr-merged", repeat: "feedback", budget: { rounds: undefined, attempts: undefined, wallTime: undefined }, runnerOptions: {}, inheritsRunner: true },
        { kind: "runner", name: "notes", prompt: "Write.", skills: [], runner: "codex", human: false, advance: true, artifact: "file docs/NOTES.md", repeat: null, budget: { rounds: undefined, attempts: undefined, wallTime: undefined }, runnerOptions: {}, inheritsRunner: true },
      ],
    });
  });
});
