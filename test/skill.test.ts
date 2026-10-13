import { describe, it, expect, vi, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { actionSets, actionsFor, anyRepoProfiles, DEFAULT_CONFIG, parseConfig, resolveProfile } from "../src/server/config.ts";
import { checkActions, checkActionsAny, checkProfiles, parsePipeline } from "../src/pipeline/load.ts";
import { findPackageRoot } from "../src/package-root.ts";
import { installSkill, skillStatus, skillTargets, VERSION_FILE } from "../src/skill/skill.ts";
import { skill } from "../src/cli/skill.ts";
import { doctor, renderDoctor } from "../src/cli/doctor.ts";

const SKILL = findPackageRoot().skillDir;
const VERSION = findPackageRoot().version;

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

const markdown = filesUnder(SKILL).filter((f) => f.endsWith(".md"));

/**
 * The skill's examples are checked with Lasso's own parsers, so docs that drift from the formats fail here.
 *
 * - `examples/<name>/` is a Lasso home: `config.yaml` and `pipelines/*.yaml`. Each is parsed, and each
 *   Pipeline is checked as saving it would be (its Actions and profiles exist in some repo) and as
 *   Intake would for every repo that names it as its default.
 * - In the markdown, every ```yaml block is marked: ```yaml lasso-config is parsed as config.yaml (a
 *   partial one is fine, as every key is optional); ```yaml lasso-pipeline is parsed as a Pipeline and
 *   its profiles checked against the shipped ones. An unmarked yaml block fails, so none goes unchecked.
 */
describe("the skill's examples", () => {
  const examples = readdirSync(path.join(SKILL, "examples"));

  it("include a GitHub- and a JIRA-tracked home", () => {
    expect(examples).toEqual(expect.arrayContaining(["github", "jira"]));
  });

  for (const example of examples) {
    it(`examples/${example} parses and its Pipelines pass Intake's checks`, () => {
      const dir = path.join(SKILL, "examples", example);
      const file = path.join(dir, "config.yaml");
      const config = parseConfig(readFileSync(file, "utf8"), file);
      expect(Object.keys(config.repos).length).toBeGreaterThan(0);
      const pipelines = new Map(
        readdirSync(path.join(dir, "pipelines")).map((f) => {
          const name = f.replace(/\.ya?ml$/, "");
          return [name, parsePipeline(name, readFileSync(path.join(dir, "pipelines", f), "utf8"))] as const;
        }),
      );
      expect(pipelines.size).toBeGreaterThan(0);
      for (const pipeline of pipelines.values()) {
        checkActionsAny(pipeline, actionSets(config));
        checkProfiles(pipeline, anyRepoProfiles(config));
      }
      for (const [name, repo] of Object.entries(config.repos)) {
        const pipeline = pipelines.get(repo.pipeline);
        expect(pipeline, `repo ${name}'s pipeline ${repo.pipeline}`).toBeDefined();
        checkActions(pipeline!, actionsFor(config, name));
        for (const stage of pipeline!.stages) {
          if (stage.kind !== "runner") continue;
          const resolved = resolveProfile(config, name, pipeline!, stage);
          expect(resolved, `repo ${name} Stage ${stage.name}`).not.toHaveProperty("problem");
        }
      }
    });
  }

  for (const file of markdown) {
    it(`every yaml block in ${file} is marked and parses`, () => {
      const text = readFileSync(path.join(SKILL, file), "utf8");
      for (const [, info, body] of text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)) {
        const [lang, marker] = info!.trim().split(/\s+/);
        if (lang !== "yaml" && lang !== "yml") continue;
        if (marker === "lasso-config") parseConfig(body!, `${file} block`);
        else if (marker === "lasso-pipeline") checkProfiles(parsePipeline("example", body!), DEFAULT_CONFIG.profiles);
        else throw new Error(`${file}: a yaml block is marked "${marker ?? ""}", not lasso-config or lasso-pipeline:\n${body}`);
      }
    });
  }

  it("links only to files the skill has", () => {
    for (const file of markdown) {
      const text = readFileSync(path.join(SKILL, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(existsSync(path.join(SKILL, path.dirname(file), target!)), `${file} links ${target}`).toBe(true);
      }
    }
  });

  it("has frontmatter naming the skill and saying when to use it", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path.join(SKILL, "SKILL.md"), "utf8"));
    const meta = parse(front![1]!) as { name?: unknown; description?: unknown };
    expect(meta.name).toBe("lasso");
    expect(meta.description).toMatch(/config\.yaml/);
    expect(meta.description).toMatch(/Flagged/);
  });
});

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "lasso-skill-home-"));
}

function capture(): { out: () => string; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  return { out: () => lines.join("\n"), restore: () => log.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe("lasso skill install", () => {
  it("copies the skill into ~/.claude/skills/lasso, stamped with the version", async () => {
    const home = tempHome();
    const out = capture();
    expect(await skill({ action: "install", dryRun: false, json: false, userHome: home })).toBe(0);
    out.restore();
    const dir = path.join(home, ".claude", "skills", "lasso");
    expect(filesUnder(dir)).toEqual([...filesUnder(SKILL), VERSION_FILE].sort());
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(readFileSync(path.join(SKILL, "SKILL.md"), "utf8"));
    expect(readFileSync(path.join(dir, VERSION_FILE), "utf8")).toBe(`${VERSION}\n`);
    expect(out.out()).toContain(`wrote ${dir} (claude) with the skill from Lasso ${VERSION}:`);
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("replaces an earlier copy whole on a rerun", () => {
    const home = tempHome();
    const [target] = skillTargets(home);
    installSkill(SKILL, [target!], "0.1.0");
    writeFileSync(path.join(target!.dir, "stale.md"), "from an older Lasso");
    const [again] = installSkill(SKILL, [target!], VERSION);
    expect(again!.replaces).toBe(true);
    expect(existsSync(path.join(target!.dir, "stale.md"))).toBe(false);
    expect(readFileSync(path.join(target!.dir, VERSION_FILE), "utf8")).toBe(`${VERSION}\n`);
  });

  it("also installs for Codex only when ~/.codex exists", async () => {
    const home = tempHome();
    expect(skillTargets(home).map((t) => t.agent)).toEqual(["claude"]);
    mkdirSync(path.join(home, ".codex"));
    const out = capture();
    expect(await skill({ action: "install", dryRun: false, json: true, userHome: home })).toBe(0);
    out.restore();
    const report = JSON.parse(out.out()) as { version: string; dryRun: boolean; targets: Array<{ agent: string; dir: string; replaces: boolean; files: string[] }> };
    expect(report.version).toBe(VERSION);
    expect(report.targets.map((t) => [t.agent, t.dir])).toEqual([
      ["claude", path.join(home, ".claude", "skills", "lasso")],
      ["codex", path.join(home, ".codex", "skills", "lasso")],
    ]);
    expect(report.targets[1]!.files).toContain("SKILL.md");
    expect(readFileSync(path.join(home, ".codex", "skills", "lasso", VERSION_FILE), "utf8")).toBe(`${VERSION}\n`);
  });

  it("writes nothing with --dry-run, and says what it would write", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const out = capture();
    expect(await skill({ action: "install", dryRun: true, json: false, userHome: home })).toBe(0);
    out.restore();
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
    expect(readdirSync(path.join(home, ".codex"))).toEqual([]);
    expect(out.out()).toContain(`would write ${path.join(home, ".claude", "skills", "lasso")} (claude)`);
    expect(out.out()).toContain(`would write ${path.join(home, ".codex", "skills", "lasso")} (codex)`);
    expect(out.out()).toContain(`  ${VERSION_FILE}`);
  });

  it("refuses anything but install", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await skill({ action: undefined, dryRun: false, json: false, userHome: tempHome() })).toBe(1);
    expect(err).toHaveBeenCalledWith("usage: lasso skill install [--dry-run] [--json]");
  });
});

describe("the skill in lasso doctor", () => {
  it("is missing, current, or from another version, per agent", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    expect(skillStatus(home, VERSION).map((s) => s.state)).toEqual(["missing", "missing"]);
    const [claude, codex] = skillTargets(home);
    installSkill(SKILL, [claude!], VERSION);
    installSkill(SKILL, [codex!], "0.1.0");
    const status = skillStatus(home, VERSION);
    expect(status.map((s) => [s.agent, s.state, s.installed])).toEqual([
      ["claude", "current", VERSION],
      ["codex", "other", "0.1.0"],
    ]);
    const text = renderDoctor("/h", [], [], status, VERSION);
    expect(text).toContain(`lasso skill for claude (${claude!.dir}): current, Lasso ${VERSION}`);
    expect(text).toContain(`lasso skill for codex (${codex!.dir}): from Lasso 0.1.0, this is Lasso ${VERSION}; run lasso skill install`);
  });

  it("reports the skill in --json and never changes the exit code", async () => {
    const lassoHome = mkdtempSync(path.join(tmpdir(), "lasso-doctor-"));
    // A config that needs only git, and a PATH whose git is a stand-in, so the tools are all found.
    writeFileSync(path.join(lassoHome, "config.yaml"), "profiles: {}\ndefault_profile: null\nnotifications: { enabled: false }\n");
    mkdirSync(path.join(lassoHome, "pipelines"));
    writeFileSync(path.join(lassoHome, "pipelines", "only.yaml"), "stages:\n  - name: work\n    prompt: Work.\n");
    const bin = mkdtempSync(path.join(tmpdir(), "lasso-doctor-bin-"));
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\n");
    chmodSync(path.join(bin, "git"), 0o755);
    const home = tempHome();
    const env = { LASSO_HOME: lassoHome, PATH: bin, HOME: home };

    let out = capture();
    expect(await doctor({ json: true, env })).toBe(0);
    out.restore();
    const report = JSON.parse(out.out()) as { skill: Array<{ agent: string; state: string }> };
    expect(report.skill).toEqual([expect.objectContaining({ agent: "claude", state: "missing", installed: null })]);

    installSkill(SKILL, skillTargets(home), "0.1.0");
    out = capture();
    expect(await doctor({ json: false, env })).toBe(0);
    out.restore();
    expect(out.out()).toContain(`from Lasso 0.1.0, this is Lasso ${VERSION}; run lasso skill install`);
  });
});
