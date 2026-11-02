import { describe, expect, it } from "vitest";
import { Git, GIT_TIMEOUT_MS } from "../src/git.ts";
import { failureReason, runTool, TOOL_TIMEOUT_MS } from "../src/tracker/exec.ts";

describe("runTool", () => {
  it("gives a tracker CLI 30 seconds by default", () => {
    expect(TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it("kills a CLI that runs past its timeout and says so", async () => {
    const started = Date.now();
    const r = await runTool("sleep", ["10"], { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBe(1);
    expect(r.errno).toBeUndefined();
    expect(failureReason("sleep", r)).toBe("sleep timed out after 0.2s");
  });

  it("leaves a CLI that finishes in time alone", async () => {
    expect(await runTool("echo", ["hi"], { timeoutMs: 5000 })).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  });
});

describe("Git", () => {
  it("gives a git command 2 minutes by default", () => {
    expect(GIT_TIMEOUT_MS).toBe(120_000);
    expect(new Git(process.cwd()).timeoutMs).toBe(120_000);
  });

  it("kills a git command that runs past its timeout and says so", async () => {
    const started = Date.now();
    await expect(new Git(process.cwd(), 200).exec(["-c", "alias.hang=!sleep 10", "hang"])).rejects.toThrow(/git -c alias\.hang=!sleep 10 hang timed out after 0\.2s/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
