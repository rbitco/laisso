import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveHome } from "../src/server/home.ts";
import { defaultConfigYaml } from "../src/server/config.ts";
import { devEnv } from "../scripts/dev-env.ts";
import { withLegacyNames } from "../src/legacy.ts";
import { installSkill } from "../src/skill/skill.ts";
import { findPackageRoot } from "../src/package-root.ts";

// Laisso was named Lasso: a Lasso install keeps working with LAISSO_DIRECTORY_NAME=.lasso and nothing else.

describe("a home Lasso made", () => {
  it("is ~/.laisso by default, or the directory LAISSO_DIRECTORY_NAME names", () => {
    expect(resolveHome({}).root).toBe(path.join(homedir(), ".laisso"));
    expect(resolveHome({ LAISSO_DIRECTORY_NAME: ".lasso" }).root).toBe(path.join(homedir(), ".lasso"));
  });

  it("is found by LASSO_HOME when LAISSO_HOME is unset", () => {
    expect(resolveHome({ LASSO_HOME: "/tmp/old", LAISSO_HOME: "/tmp/new" }).root).toBe("/tmp/new");
    expect(resolveHome({ LASSO_HOME: "/tmp/old" }).root).toBe("/tmp/old");
  });

  it("keeps its lasso.db, lasso.pid and lasso.log, while a new home gets laisso.*", () => {
    const root = mkdtempSync(path.join(tmpdir(), "laisso-legacy-"));
    expect(path.basename(resolveHome({ LAISSO_HOME: root }).dbFile)).toBe("laisso.db");
    writeFileSync(path.join(root, "lasso.db"), "");
    const home = resolveHome({ LAISSO_HOME: root });
    expect([home.dbFile, home.pidFile, home.logFile].map((f) => path.basename(f))).toEqual(["lasso.db", "lasso.pid", "lasso.log"]);
    writeFileSync(path.join(root, "laisso.db"), "");
    expect(path.basename(resolveHome({ LAISSO_HOME: root }).dbFile)).toBe("laisso.db");
  });

  it("takes a new config's port from LASSO_PORT when LAISSO_PORT is unset", () => {
    expect(defaultConfigYaml({ LASSO_PORT: "7500" })).toMatch(/^port: 7500/m);
  });

  it("keeps a dev clone's home beside it, as ~/.lasso-dev", () => {
    expect(devEnv({ LAISSO_DIRECTORY_NAME: ".lasso" }, "/u").LAISSO_HOME).toBe("/u/.lasso-dev");
    expect(devEnv({}, "/u").LAISSO_HOME).toBe("/u/.laisso-dev");
  });
});

describe("scripts and prompts written for Lasso", () => {
  it("see each LAISSO_* variable under its LASSO_* name too", () => {
    expect(withLegacyNames({ LAISSO_TICKET: "A", LAISSO_CHANNEL: "ops", PATH: "/bin" })).toEqual({ LAISSO_TICKET: "A", LAISSO_CHANNEL: "ops", PATH: "/bin", LASSO_TICKET: "A", LASSO_CHANNEL: "ops" });
  });
});

describe("installing the skill over Lasso's", () => {
  const skillsDir = () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "laisso-skill-")), "skills");
    mkdirSync(path.join(dir, "lasso"), { recursive: true });
    writeFileSync(path.join(dir, "lasso", "SKILL.md"), "");
    return dir;
  };

  it("removes the copy Lasso stamped", () => {
    const dir = skillsDir();
    writeFileSync(path.join(dir, "lasso", ".lasso-version"), "0.13.0\n");
    installSkill(findPackageRoot().skillDir, [{ agent: "claude", dir: path.join(dir, "laisso") }], "1.0.0");
    expect([existsSync(path.join(dir, "lasso")), existsSync(path.join(dir, "laisso", "SKILL.md"))]).toEqual([false, true]);
  });

  it("leaves a lasso skill Lasso did not install", () => {
    const dir = skillsDir();
    installSkill(findPackageRoot().skillDir, [{ agent: "claude", dir: path.join(dir, "laisso") }], "1.0.0");
    expect(existsSync(path.join(dir, "lasso", "SKILL.md"))).toBe(true);
  });
});
