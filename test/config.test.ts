import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, loadConfig, ConfigError } from "../src/server/config.ts";
import { resolveHome } from "../src/server/home.ts";

describe("the default config.yaml", () => {
  it("parses to exactly the built-in defaults, so the two cannot drift", () => {
    expect(parse(DEFAULT_CONFIG_YAML)).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig", () => {
  const homeWith = (yaml: string) => {
    const home = resolveHome({ LASSO_HOME: mkdtempSync(path.join(tmpdir(), "lasso-config-")) });
    writeFileSync(home.configFile, yaml);
    return home;
  };

  it("refuses a concurrency that is zero, negative, or fractional", () => {
    for (const bad of ["0", "-1", "1.5"]) {
      expect(() => loadConfig(homeWith(`concurrency: ${bad}\n`))).toThrow(ConfigError);
      expect(() => loadConfig(homeWith(`concurrency: ${bad}\n`))).toThrow(/concurrency must be a whole number of 1 or more/);
    }
    expect(loadConfig(homeWith("concurrency: 4\n")).concurrency).toBe(4);
    expect(loadConfig(homeWith("concurrency: many\n")).concurrency).toBe(3);
  });
});
