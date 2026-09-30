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
    expect(() => loadConfig(homeWith("concurrency: many\n"))).toThrow(/concurrency must be a whole number of 1 or more, not many/);
    expect(() => loadConfig(homeWith("budget: 5\n"))).toThrow(/budget must be a mapping, not 5/);
    expect(() => loadConfig(homeWith("budget: { wallTime: 30 }\n"))).toThrow(/budget\.wallTime/);
    expect(loadConfig(homeWith("")).concurrency).toBe(3);
  });

  it("reads Actions, with params and a timeout defaulting to 5m, and refuses a malformed one", () => {
    const yaml = (actions: string) => `actions:\n${actions}`;
    expect(loadConfig(homeWith(yaml("  notify:\n    params: [channel]\n    run: echo hi\n  slack.post:\n    timeout: 30s\n    run: ./post\n"))).actions).toEqual({
      notify: { run: "echo hi", params: ["channel"], timeout: "5m" },
      "slack.post": { run: "./post", params: [], timeout: "30s" },
    });
    expect(() => loadConfig(homeWith(yaml("  notify: {}\n")))).toThrow(/actions\.notify: run must be a command/);
    expect(() => loadConfig(homeWith(yaml("  Notify:\n    run: x\n")))).toThrow(/actions\.Notify: an Action name is lowercase/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    params: [Channel]\n")))).toThrow(/actions\.notify: params must be a list of names/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    params: [a, a]\n")))).toThrow(/params names one param twice/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    timeout: soon\n")))).toThrow(/actions\.notify\.timeout/);
    expect(() => loadConfig(homeWith(yaml("  notify:\n    run: x\n    command: y\n")))).toThrow(/actions\.notify: unknown field command/);
  });
});
