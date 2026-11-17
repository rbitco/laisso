// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { DEFAULT_CONFIG } from "../src/server/config.ts";
import type { PipelineListing } from "../src/api/views.ts";
import type { Detection } from "../src/intake/detect.ts";
import { ConfirmIntake } from "../src/dashboard/app/header/Intake.tsx";

// The Intake picker with a Pipeline that does not load (LASSO-218): listed with its problem, never choosable.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const listing = (name: string, problem: string | null = null): PipelineListing => ({
  name,
  file: `/p/${name}.yaml`,
  profile: null,
  problem,
  parts: false,
  stages: problem ? [] : [{ name: "work", kind: "runner", label: "work", profile: null }],
});

describe("the Intake picker", () => {
  it("shows a Pipeline that does not load disabled with its problem, and does not preselect it as the repo default", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/config") return json({ config: { ...DEFAULT_CONFIG, repos: {} } });
      if (url === "/api/pipelines") return json([listing("bug-fix", "Pipeline bug-fix stage 1 (use default.nope): default has no Stage named nope"), listing("default")]);
      return json({});
    });
    // As detect gives it: the repo wants bug-fix, which does not load, so default stands in.
    const detection: Detection = {
      kind: "prompt",
      reference: null,
      repo: { suggestion: "app", choices: ["app"] },
      pipeline: { suggestion: "default", choices: ["bug-fix", "default"], byRepo: { app: "default" } },
      title: null,
      branch: null,
      notes: [],
    };
    render(<ConfirmIntake detected={{ input: "Fix it", detection }} onCancel={() => {}} onAdded={() => {}} />);
    const broken = (await screen.findByText("Pipeline bug-fix stage 1 (use default.nope): default has no Stage named nope")).closest("label")!;
    const radio = within(broken).getByRole("radio") as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(radio.checked).toBe(false);
    expect(within(broken).getByText("does not load")).toBeTruthy();
    const chosen = screen.getByRole("radio", { name: /^default/ }) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
  });
});
