import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML } from "../src/server/config.ts";

describe("the default config.yaml", () => {
  it("parses to exactly the built-in defaults, so the two cannot drift", () => {
    expect(parse(DEFAULT_CONFIG_YAML)).toEqual(DEFAULT_CONFIG);
  });
});
