import { describe, it, expect } from "vitest";
import { checkActions, checkProfiles, parsePipeline, PipelineError } from "../src/pipeline/load.ts";
import { DEFAULT_PIPELINE_YAML } from "../src/pipeline/default.ts";

// Seam two, pure: every rule of the spec's Pipeline format, each with a
// failing case (LASSO-40), and one Pipeline that uses every field.
const STAGES = (body: string) => `profile: claude\nstages:\n${body}`;

const FAILING: Array<[string, string, RegExp]> = [
  ["an empty file", "", /is empty/],
  ["no stages", "profile: claude\n", /has no stages/],
  ["a stage that is not a mapping", STAGES("  - implement\n"), /stage 1 is not a mapping/],
  ["a stage with both action and prompt", STAGES("  - name: x\n    prompt: p\n    action: tracker.transition\n    with: { status: Done }\n"), /has both action and prompt\/skills/],
  ["a stage with neither prompt, skills nor action", STAGES("  - name: x\n    artifact: pr-exists\n"), /needs a prompt, skills, an action, or a wait/],
  ["an action that could not be an Action's name", STAGES("  - action: Tell Ops\n"), /Tell Ops is not an Action name/],
  ["a status outside with, as before ADR 0010", STAGES("  - action: tracker.transition\n    status: Done\n"), /stage 1: status is now a param; write with: \{ status: Done \}/],
  ["an action stage carrying Runner fields", STAGES("  - action: notify\n    human: true\n"), /stage 1: human is not a field of an action Stage/],
  ["an action stage's with that is not a mapping", STAGES("  - action: notify\n    with: ops\n"), /with must be a mapping of param to value/],
  ["an action stage's param that is a list", STAGES("  - action: notify\n    with: { channel: [a, b] }\n"), /with\.channel must be a single value/],
  ["an action stage name with spaces", STAGES("  - action: notify\n    name: Tell Ops\n"), /needs a name of lowercase letters, digits, and hyphens/],
  ["two runs of one Action unnamed", STAGES("  - action: notify\n  - action: notify\n"), /has two Stages named notify/],
  ["a stage without a name", STAGES("  - prompt: p\n"), /needs a name of lowercase letters, digits, and hyphens/],
  ["a name with spaces", STAGES("  - name: Do Work\n    prompt: p\n"), /needs a name of lowercase letters, digits, and hyphens/],
  ["two stages with one name", STAGES("  - name: x\n    prompt: p\n  - name: x\n    prompt: q\n"), /has two Stages named x/],
  ["an unknown artifact", STAGES("  - name: x\n    prompt: p\n    artifact: pr-approved\n"), /unknown artifact pr-approved/],
  ["a file artifact that escapes the worktree", STAGES("  - name: x\n    prompt: p\n    artifact: file ../etc/passwd\n"), /unknown artifact file \.\.\/etc\/passwd/],
  ["a check Action artifact naming no Action name", STAGES("  - name: x\n    prompt: p\n    artifact: action Ci Green\n"), /unknown artifact action Ci Green/],
  ["a check Action artifact object without action", STAGES("  - name: x\n    prompt: p\n    artifact: { with: { file: a } }\n"), /a check Action artifact needs action: <name>/],
  ["a check Action artifact object with an unknown key", STAGES("  - name: x\n    prompt: p\n    artifact: { action: grep, params: { file: a } }\n"), /params is not a field of a check Action artifact/],
  ["a check Action artifact's param that is a list", STAGES("  - name: x\n    prompt: p\n    artifact: { action: grep, with: { file: [a] } }\n"), /artifact\.with\.file must be a single value/],
  ["a repeat trigger other than feedback", STAGES("  - name: x\n    prompt: p\n    repeat: always\n"), /repeat must be feedback/],
  ["a repeating stage with no artifact to end it", STAGES("  - name: x\n    prompt: p\n    repeat: feedback\n"), /a repeating Stage needs an artifact/],
  ["two transitions to one status", STAGES("  - action: tracker.transition\n    with: { status: Done }\n  - action: tracker.transition\n    with: { status: Done }\n"), /has two Stages named transition-done/],
  ["a Pipeline runner, as before ADR 0011", "runner: codex\nstages:\n  - name: x\n    prompt: p\n", /Pipeline p: runner is now an Agent Profile in config\.yaml; write profile: codex/],
  ["a Stage runner, as before ADR 0011", STAGES("  - name: x\n    prompt: p\n    runner: pi\n"), /stage 1: runner is now an Agent Profile in config\.yaml; write profile: pi/],
  ["runnerOptions, as before ADR 0011", STAGES("  - name: x\n    prompt: p\n    runnerOptions: { args: [--verbose] }\n"), /stage 1: runnerOptions are now an Agent Profile in config\.yaml; .*write profile: p-x/],
  ["a profile that could not be a profile's name", STAGES("  - name: x\n    prompt: p\n    profile: Big Model\n"), /stage 1: profile must name an Agent Profile, not Big Model/],
  ["a Pipeline profile that is not text", "profile: [a]\nstages:\n  - name: x\n    prompt: p\n", /Pipeline p: profile must name an Agent Profile/],
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
  ["an unknown Pipeline field", "profle: claude\nstages:\n  - name: x\n    prompt: p\n", /Pipeline p: unknown field profle/],
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
profile: codex-fast
budget:
  spend: 12.5
stages:
  - name: grill
    human: true
    advance: false
    skills: [grilling, to-spec]
    prompt: Talk.
    artifact: tracker-spec
    profile: claude-opus
    budget: { rounds: 1, attempts: 3, wallTime: 45m }
  - action: tracker.transition
    with: { status: In Progress }
  - action: slack.post
    with: { channel: ops, count: 2 }
  - action: slack.post
    name: tell-team
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
      profile: "codex-fast",
      budget: { spend: 12.5 },
      stages: [
        { kind: "runner", name: "grill", prompt: "Talk.", skills: ["grilling", "to-spec"], profile: "claude-opus", human: true, advance: false, artifact: "tracker-spec", repeat: null, budget: { rounds: 1, attempts: 3, wallTime: "45m" } },
        { kind: "action", name: "transition-in-progress", action: "tracker.transition", with: { status: "In Progress" } },
        { kind: "action", name: "post-ops-2", action: "slack.post", with: { channel: "ops", count: "2" } },
        { kind: "action", name: "tell-team", action: "slack.post", with: {} },
        { kind: "runner", name: "review", prompt: "Address feedback.", skills: [], profile: null, human: false, advance: true, artifact: "pr-merged", repeat: "feedback", budget: { rounds: undefined, attempts: undefined, wallTime: undefined } },
        { kind: "runner", name: "notes", prompt: "Write.", skills: [], profile: null, human: false, advance: true, artifact: "file docs/NOTES.md", repeat: null, budget: { rounds: undefined, attempts: undefined, wallTime: undefined } },
      ],
    });
  });
});

describe("checkActions", () => {
  const actions = { notify: { run: "true", params: ["channel"], timeout: "5m" } };
  const check = (body: string) => () => checkActions(parsePipeline("p", STAGES(body)), actions);

  it("accepts a Stage naming a config Action with exactly its params", () => {
    expect(check("  - action: notify\n    with: { channel: ops }\n")).not.toThrow();
  });

  it("refuses an unknown Action, a missing param, and an extra one", () => {
    expect(check("  - action: page\n")).toThrow(/Pipeline p Stage page: no Action named page in config\.yaml/);
    expect(check("  - action: notify\n")).toThrow(/Stage notify: notify needs with\.channel/);
    expect(check("  - action: notify\n    with: { channel: ops, loud: true }\n")).toThrow(/notify takes no param loud/);
    expect(check("  - action: tracker.transition\n    with: { status: Done }\n")).toThrow(/Stage transition-done: no Action named tracker\.transition in config\.yaml/);
  });
});

describe("a check Action artifact", () => {
  const actions = { "ci-green": { run: "true", params: [], timeout: "5m" }, grep: { run: "true", params: ["file", "pattern"], timeout: "5m" } };
  const check = (body: string) => () => checkActions(parsePipeline("p", STAGES(body)), actions);

  it("reads as action <name>, with its params from the object form", () => {
    const stages = parsePipeline("p", STAGES("  - name: a\n    prompt: p\n    artifact: action ci-green\n  - name: b\n    prompt: p\n    artifact:\n      action: grep\n      with: { file: CHANGELOG.md, pattern: 1 }\n")).stages;
    expect(stages[0]).toMatchObject({ artifact: "action ci-green", artifactWith: {} });
    expect(stages[1]).toMatchObject({ artifact: "action grep", artifactWith: { file: "CHANGELOG.md", pattern: "1" } });
    expect(check("  - name: a\n    prompt: p\n    artifact: { action: grep, with: { file: a, pattern: b } }\n")).not.toThrow();
  });

  it("is checked against config's Actions like an action Stage", () => {
    expect(check("  - name: a\n    prompt: p\n    artifact: action deploy-green\n")).toThrow(/Pipeline p Stage a artifact: no Action named deploy-green in config\.yaml/);
    expect(check("  - name: a\n    prompt: p\n    artifact: action grep\n")).toThrow(/Stage a artifact: grep needs with\.file, with\.pattern/);
    expect(check("  - name: a\n    prompt: p\n    artifact: { action: ci-green, with: { loud: yes } }\n")).toThrow(/ci-green takes no param loud/);
  });

  it("can end a repeating Stage", () => {
    expect(parsePipeline("p", STAGES("  - name: a\n    prompt: p\n    repeat: feedback\n    artifact: action ci-green\n")).stages[0]).toMatchObject({ repeat: "feedback", artifact: "action ci-green", artifactWith: {} });
  });
});

describe("checkProfiles", () => {
  const profiles = { claude: { runner: "claude" as const }, "codex-fast": { runner: "codex" as const, model: "gpt-5-codex" } };

  it("accepts profiles config defines, and Stages that name none", () => {
    expect(() => checkProfiles(parsePipeline("p", "profile: codex-fast\nstages:\n  - name: x\n    prompt: p\n    profile: claude\n  - name: y\n    prompt: q\n"), profiles)).not.toThrow();
  });

  it("refuses a profile config lacks, on the Pipeline or a Stage", () => {
    expect(() => checkProfiles(parsePipeline("p", "profile: opus\nstages:\n  - name: x\n    prompt: p\n"), profiles)).toThrow(/Pipeline p: no profile named opus in config\.yaml/);
    expect(() => checkProfiles(parsePipeline("p", STAGES("  - name: x\n    prompt: p\n    profile: sonnet\n")), profiles)).toThrow(/Pipeline p Stage x: no profile named sonnet in config\.yaml/);
  });
});

describe("the default Pipeline", () => {
  it("names Fable for the thinking Stages and Sonnet for Document, and leaves Implement and Review to default_profile", () => {
    const pipeline = parsePipeline("default", DEFAULT_PIPELINE_YAML);
    expect(pipeline.profile).toBeNull();
    expect(pipeline.stages.flatMap((s) => (s.kind === "runner" ? [[s.name, s.profile]] : []))).toEqual([
      ["grill", "claude-fable"],
      ["plan", "claude-fable"],
      ["implement", null],
      ["document", "claude-sonnet"],
      ["code-review", "claude-fable"],
      ["review", null],
    ]);
  });

  it("has code-review post one review on each Owned PR, not just the branch (LASSO-166)", () => {
    const stage = parsePipeline("default", DEFAULT_PIPELINE_YAML).stages.find((s) => s.kind === "runner" && s.name === "code-review");
    const prompt = stage?.kind === "runner" ? stage.prompt : null;
    expect(prompt).toContain("Review each Owned PR");
    expect(prompt).toContain("one PR review per Owned PR");
    expect(prompt).not.toContain("this branch");
  });
});
