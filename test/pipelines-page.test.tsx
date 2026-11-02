// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { LiveVersionView, PipelineFile, PipelineListing, PipelineVersionView, PipelineView } from "../src/api/views.ts";
import { PipelinesPage } from "../src/dashboard/app/pipelines/PipelinesPage.tsx";
import { BLANK_PIPELINE } from "../src/dashboard/app/pipelines/PipelineList.tsx";
import { events } from "../src/dashboard/app/events.ts";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";
import { ProfileDrawerHost } from "../src/dashboard/app/profiles/drawer.tsx";

// The Pipelines page as a person uses it (ADR 0012): the list, + New Pipeline, Delete, the text editor, and Versions.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const DEFAULT_TEXT = "stages:\n  - name: plan\n    prompt: Plan it.\n  - name: notify\n    action: transition\n    with: { status: Review }\n";
const DEFAULT: PipelineView = {
  profile: null,
  budget: {},
  stages: [
    { kind: "runner", name: "plan", label: "plan", prompt: "Plan it.\nCarefully.", skills: [], profile: null, human: false, advance: true, artifact: "spec", repeat: null, budget: { rounds: 2 } },
    { kind: "action", name: "notify", label: "Review", action: "transition", with: { status: "Review" } },
  ],
};

interface Stored {
  text: string;
  pipeline: PipelineView | null;
  problem: string | null;
}

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Laisso's /api: the Pipeline files as they stand, their live Versions, and every write it was sent. */
function fakeLaisso(files: Record<string, Stored> = { default: { text: DEFAULT_TEXT, pipeline: DEFAULT, problem: null } }) {
  const sent: Sent[] = [];
  const state = { files, refuse: null as string | null, versions: {} as Record<string, LiveVersionView[]>, frozen: {} as Record<string, PipelineVersionView> };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fileView = (name: string): PipelineFile => ({ name, file: `/p/${name}.yaml`, ...state.files[name]! });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (url === "/api/pipelines")
      return json(
        Object.entries(state.files).map(([name, f]): PipelineListing => ({ name, file: `/p/${name}.yaml`, profile: null, problem: f.problem, stages: (f.pipeline?.stages ?? []).map((s) => ({ name: s.name, kind: s.kind, label: s.label, profile: null })) })),
      );
    const m = /^\/api\/pipelines\/([^/]+)(\/versions(?:\/(\d+))?)?$/.exec(url);
    if (!m) return json({ error: "not found" }, 404);
    const name = decodeURIComponent(m[1]!);
    if (m[3]) return state.frozen[`${name}/v${m[3]}`] ? json(state.frozen[`${name}/v${m[3]}`]) : json({ error: `no Version ${m[3]} of Pipeline ${name}` }, 404);
    if (m[2]) return json(state.versions[name] ?? []);
    if (method === "GET") return state.files[name] ? json(fileView(name)) : json({ error: `no Pipeline named ${name}` }, 404);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    if (state.refuse) return json({ error: state.refuse }, 400);
    if (method === "DELETE") {
      delete state.files[name];
      return json({ ok: true });
    }
    if (method === "PUT") {
      if (body.create && state.files[name]) return json({ error: `a Pipeline named ${name} already exists` }, 400);
      state.files[name] = { text: body.text, pipeline: DEFAULT, problem: null };
      return json(fileView(name));
    }
    return json({ error: "not found" }, 404);
  });
  return { sent, state };
}

const notice = () => document.querySelector('[data-role="notice"]')!;
const list = () => document.querySelector<HTMLElement>(".plist")!;

async function showPage(name: string | null = null, version: number | null = null) {
  const view = render(<PipelinesPage name={name} version={version} visit={1} />);
  await waitFor(() => expect(list()).toBeTruthy());
  // An editor shows once its file is read.
  if (name && !version) await screen.findByText(`/p/${name}.yaml`);
  return view;
}

/** What the app draws over every view: the notice line and the profile drawer. */
const Overlays = () => (
  <>
    <Notice />
    <ProfileDrawerHost />
  </>
);

beforeEach(() => {
  showNotice("");
  render(<Overlays />);
  location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Pipelines list", () => {
  it("draws each Pipeline as a line of its Stages, counted, and says when a file does not load", async () => {
    fakeLaisso({ default: { text: DEFAULT_TEXT, pipeline: DEFAULT, problem: null }, broken: { text: "stages: [", pipeline: null, problem: "bad YAML" } });
    await showPage("default");
    const links = within(list()).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#pipelines/default", "#pipelines/broken"]);
    expect(links[0]!.className).toBe("current");
    expect(links[0]!.title).toBe("plan → Review");
    expect(links[0]!.textContent).toContain("2 Stages");
    expect(links[0]!.querySelectorAll("circle, rect")).toHaveLength(2);
    expect(links[1]!.textContent).toBe("brokendoes not load");
  });

  it("reads the list again when another client changes a Pipeline", async () => {
    const laisso = fakeLaisso();
    await showPage();
    expect(screen.getByText("Pick a Pipeline to edit it, or make a new one.")).toBeTruthy();
    laisso.state.files.quick = { text: DEFAULT_TEXT, pipeline: DEFAULT, problem: null };
    act(() => void events().dispatchEvent(new Event("pipeline")));
    await within(list()).findByText("quick");
  });
});

describe("+ New Pipeline", () => {
  it("creates a blank Pipeline, or a copy of one listed, and opens it", async () => {
    const laisso = fakeLaisso();
    const view = await showPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New Pipeline" }));
    await user.type(screen.getByLabelText("Name"), " hotfix ");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(location.hash).toBe("#pipelines/hotfix"));
    expect(laisso.sent).toEqual([{ method: "PUT", route: "/api/pipelines/hotfix", body: { text: BLANK_PIPELINE, create: true } }]);

    // The new hash shows the page again, open on the new Pipeline, with + New Pipeline closed.
    view.rerender(<PipelinesPage name="hotfix" version={null} visit={2} />);
    await within(list()).findByText("hotfix");
    expect(within(list()).getByText("hotfix").closest("a")!.className).toBe("current");
    await user.click(screen.getByRole("button", { name: "+ New Pipeline" }));
    // The open Pipeline's Stages have names of their own.
    await user.type(within(document.querySelector<HTMLElement>('[data-role="new-pipeline"]')!).getByLabelText("Name"), "careful");
    await user.selectOptions(screen.getByLabelText("Start from"), "A copy of default");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(location.hash).toBe("#pipelines/careful"));
    expect(laisso.sent[1]).toEqual({ method: "PUT", route: "/api/pipelines/careful", body: { text: DEFAULT_TEXT, create: true } });
  });

  it("shows the server's refusal and keeps the form, for a name already taken", async () => {
    fakeLaisso();
    await showPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New Pipeline" }));
    await user.type(screen.getByLabelText("Name"), "default");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(notice().textContent).toBe("a Pipeline named default already exists"));
    expect(location.hash).toBe("");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("a Pipeline's editor", () => {
  it("opens on the Stage editor, with the Versions active Tickets still run", async () => {
    const laisso = fakeLaisso();
    laisso.state.versions.default = [{ version: 1, createdAt: "2026-10-01T00:00:00Z", live: 2 }, { version: 3, createdAt: "2026-10-02T00:00:00Z", live: 1 }];
    await showPage("default");
    await screen.findByText("Pipeline settings");
    expect(screen.getByText("/p/default.yaml")).toBeTruthy();
    const strip = await screen.findByText("Versions in use");
    expect(within(strip.parentElement!).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["v1 (2 Tickets)", "#pipelines/default/v1"],
      ["v3 (1 Ticket)", "#pipelines/default/v3"],
    ]);
    expect(screen.getByRole("textbox", { name: "default as text", hidden: true }).closest("[hidden]")).toBeTruthy();
  });

  it("deletes only on a second click, then goes back to the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const laisso = fakeLaisso();
      await showPage("default");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(laisso.sent).toEqual([]);
      // Left alone, it disarms.
      act(() => void vi.advanceTimersByTime(4000));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(laisso.sent).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Click again to delete" }));
      await waitFor(() => expect(location.hash).toBe("#pipelines"));
      expect(laisso.sent).toEqual([{ method: "DELETE", route: "/api/pipelines/default", body: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the whole file as text, then reads it again on the Stage editor", async () => {
    const laisso = fakeLaisso();
    await showPage("default");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit as text" }));
    const area = screen.getByRole("textbox", { name: "default as text" }) as HTMLTextAreaElement;
    expect(area.value).toBe(DEFAULT_TEXT);
    expect((await screen.findByText("Pipeline settings")).closest("[hidden]")).toBeTruthy();
    await user.type(area, "# reviewed\n");
    await user.click(screen.getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(notice().textContent).toBe("saved default"));
    expect(laisso.sent).toEqual([{ method: "PUT", route: "/api/pipelines/default", body: { text: DEFAULT_TEXT + "# reviewed\n" } }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit as text" })).toBeTruthy());
    expect((await screen.findByText("Pipeline settings")).closest("[hidden]")).toBeNull();
  });

  it("shows a refused text save and keeps the text, to fix and save again", async () => {
    const laisso = fakeLaisso();
    laisso.state.refuse = "stages[0]: a Stage needs a name";
    await showPage("default");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit as text" }));
    const area = screen.getByRole("textbox", { name: "default as text" }) as HTMLTextAreaElement;
    await user.clear(area);
    await user.type(area, "stages:\n  - prompt: nameless\n");
    await user.click(screen.getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(notice().textContent).toBe("stages[0]: a Stage needs a name"));
    expect(area.value).toBe("stages:\n  - prompt: nameless\n");
    expect(area.closest("[hidden]")).toBeNull();
    expect((screen.getByRole("button", { name: "Save text" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens a file that does not load as text, with its problem shown", async () => {
    fakeLaisso({ broken: { text: "stages: [", pipeline: null, problem: "bad YAML at line 1" } });
    await showPage("broken");
    await screen.findByText("This file does not load: bad YAML at line 1. Fix it as text.");
    const area = screen.getByRole("textbox", { name: "broken as text" }) as HTMLTextAreaElement;
    expect(area.value).toBe("stages: [");
    expect(area.closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit as text" })).toBeNull();
    expect(screen.queryByText("Pipeline settings")).toBeNull();
  });
});

describe("a frozen Version", () => {
  const frozen = (deleted: boolean): PipelineVersionView => ({ name: "default", version: 2, createdAt: new Date(Date.now() - 3 * 60_000).toISOString(), live: 1, deleted, pipeline: DEFAULT });

  it("shows read-only what a Ticket's Pipeline link points at, with a way to the current Pipeline", async () => {
    const laisso = fakeLaisso();
    laisso.state.frozen["default/v2"] = frozen(false);
    await showPage("default", 2);
    await screen.findByText("default v2");
    expect(screen.getByText("Read-only. Frozen 3m ago, 1 active Ticket.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the current Pipeline" }).getAttribute("href")).toBe("#pipelines/default");
    expect(screen.queryByRole("button", { name: /Save|Delete|Edit as text/ })).toBeNull();
    // The Runner Stage starts closed to its line; the action Stage shows its fields.
    const plan = screen.getByRole("button", { name: /^plan/ });
    expect(plan.getAttribute("aria-expanded")).toBe("false");
    expect(plan.textContent).toBe("planRunnerartifact specPlan it.");
    expect(screen.getByRole("button", { name: /^notify/ }).getAttribute("aria-expanded")).toBe("true");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(plan.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("rounds 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
  });

  it("says when the Pipeline is gone, and when there is no such Version", async () => {
    const laisso = fakeLaisso();
    laisso.state.frozen["default/v2"] = frozen(true);
    const view = await showPage("default", 2);
    await screen.findByText("Pipeline deleted");
    expect(screen.queryByRole("link", { name: "Open the current Pipeline" })).toBeNull();
    view.rerender(<PipelinesPage name="default" version={9} visit={2} />);
    await screen.findByText("no Version 9 of Pipeline default");
  });
});
