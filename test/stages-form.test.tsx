// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG, type Config } from "../src/server/config.ts";
import type { ActionListing, ConfigFile, PipelineView } from "../src/api/views.ts";
import { StagesForm, type LoadedPipeline } from "../src/dashboard/app/pipelines/StagesForm.tsx";
import { closeProfileDrawer, ProfileDrawerHost } from "../src/dashboard/app/profiles/drawer.tsx";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";

// The Stage editor as a person uses it (ADR 0012): what each edit, add, move and removal sends on Save.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const PIPELINE: PipelineView = {
  profile: null,
  budget: {},
  stages: [
    { kind: "runner", name: "plan", label: "plan", prompt: "Plan it.\nCarefully.", skills: ["grilling"], profile: null, human: false, advance: true, artifact: "spec", repeat: null, budget: { rounds: 2 } },
    { kind: "action", name: "notify", label: "Review", action: "transition", with: { status: "Review" } },
  ],
};

const ACTIONS: ActionListing[] = [
  { name: "transition", repo: null, params: ["status"], timeout: "5m", run: "./move" },
  { name: "deploy", repo: null, params: ["env", "region"], timeout: "5m", run: "./deploy" },
  { name: "deploy", repo: "web", params: ["env"], timeout: "5m", run: "./web-deploy" },
];

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  profiles: { "claude-opus": { runner: "claude", model: "opus" }, codex: { runner: "codex", model: "gpt-6-sol" } },
  default_profile: "claude-opus",
  // A repo with its own claude-opus, which a Stage, having no repo, does not open on.
  repos: { app: { path: "/code/app", tracker: "jira", project: "APP", pipeline: "default", actions: {}, profiles: { "claude-opus": { runner: "claude", model: "haiku" } }, default_profile: null } },
};

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Lasso's /api: config, its Actions, and every write it was sent; `refuse` makes the next write fail. */
function fakeLasso() {
  const sent: Sent[] = [];
  const state = { refuse: null as string | null };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET" && url === "/api/actions") return json(ACTIONS);
    if (method === "GET" && url === "/api/config") return json({ file: "/c.yaml", text: "", config: CONFIG, restart: [] } satisfies ConfigFile);
    if (method === "GET" && url === "/api/pipelines") return json([]);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    if (state.refuse) return json({ error: state.refuse }, 400);
    return json({});
  });
  return { sent, state };
}

const notice = () => document.querySelector('[data-role="notice"]')!;
/** A Stage on the line, by the name its head shows. */
const stage = (name: string) => screen.getByText(name, { selector: ".nm" }).closest<HTMLElement>(".stage")!;
const toggle = (name: string) => within(stage(name)).getAllByRole("button")[0]!;
const saveState = () => document.querySelector(".savebar .state")!.textContent;

async function showForm(pipeline: PipelineView = PIPELINE) {
  const onSaved = vi.fn();
  const file: LoadedPipeline = { name: "default", file: "/p/default.yaml", text: "", pipeline, problem: null };
  render(<StagesForm file={file} onSaved={onSaved} />);
  await screen.findByText("Pipeline settings");
  return { onSaved, user: userEvent.setup() };
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save changes" }));
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
});
afterEach(() => {
  closeProfileDrawer();
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Stage line", () => {
  it("numbers each Stage, marks its kind, and closes it to one line until opened", async () => {
    fakeLasso();
    const { user } = await showForm();
    expect([...document.querySelectorAll(".rail > .stage .station")].map((s) => s.textContent)).toEqual(["1", "2"]);
    expect(stage("plan").className).toBe("stage k-runner");
    expect(stage("notify").className).toBe("stage k-action");
    expect(within(stage("plan")).getByText("claude-opus, leaves spec", { selector: ".sum" })).toBeTruthy();
    expect(within(stage("plan")).getByText("Plan it.", { selector: ".peek" })).toBeTruthy();
    expect(within(stage("notify")).getByText("transition, status: Review", { selector: ".sum" })).toBeTruthy();
    expect(within(stage("plan")).queryByRole("textbox", { name: "Prompt" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(within(stage("plan")).getByRole("textbox", { name: "Prompt" })).toBeTruthy();
    expect(within(stage("notify")).getByRole("textbox", { name: "status" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(stage("plan").className).toBe("stage k-runner");
    // Opening and closing changes nothing to save.
    expect(saveState()).toBe("No unsaved changes");
  });

  it("redraws a Stage's line as it is edited: a Human Stage, what it leaves, and how it moves on", async () => {
    fakeLasso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.click(within(plan).getByRole("checkbox", { name: "Human Stage: opens a terminal for you to work in" }));
    await user.clear(within(plan).getByRole("textbox", { name: "Artifact" }));
    await user.click(within(plan).getByRole("checkbox", { name: "Move to the next Stage on its own" }));
    await user.click(within(plan).getByRole("checkbox", { name: "Repeat on Feedback until the artifact is met" }));
    expect(plan.className).toBe("stage k-human open");
    expect(within(plan).getByText("Human")).toBeTruthy();
    expect(within(plan).getByText("claude-opus, no artifact, repeats on Feedback, waits for Start", { selector: ".sum" })).toBeTruthy();
    expect(saveState()).toBe("Unsaved changes");
    expect(document.querySelector("form")!.className).toBe("pipe-form dirty");
  });
});

describe("Save", () => {
  it("sends only the changed fields of an edit, a blank clearing its key, with the Pipeline's own settings", async () => {
    const lasso = fakeLasso();
    const { user, onSaved } = await showForm();
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent Profile" }), "codex");
    await user.type(screen.getByRole("textbox", { name: "Spend limit per Ticket (USD)" }), "4.5");
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.clear(within(plan).getByRole("textbox", { name: "Prompt" }));
    await user.type(within(plan).getByRole("textbox", { name: "Prompt" }), "Plan it.");
    await user.clear(within(plan).getByRole("textbox", { name: "Skills" }));
    await user.type(within(plan).getByRole("textbox", { name: "Skills" }), "grilling,  to-spec ,");
    await user.clear(within(plan).getByRole("textbox", { name: "Feedback rounds" }));
    await user.type(within(plan).getByRole("textbox", { name: "Time per Session" }), "45m");
    // Changed and changed back: nothing for it.
    await user.type(within(plan).getByRole("textbox", { name: "Artifact" }), "x");
    await user.type(within(plan).getByRole("textbox", { name: "Artifact" }), "{Backspace}");
    await user.click(toggle("notify"));
    await user.clear(within(stage("notify")).getByRole("textbox", { name: "status" }));
    await user.type(within(stage("notify")).getByRole("textbox", { name: "status" }), "Done");
    await save(user);

    await waitFor(() => expect(notice().textContent).toBe("saved default"));
    expect(lasso.sent).toEqual([{ method: "PATCH", route: "/api/pipelines/default", body: { budget: { spend: 4.5 }, stages: { plan: { prompt: "Plan it.", skills: ["grilling", "to-spec"], budget: { rounds: null, wallTime: "45m" } }, notify: { with: { status: "Done" } } }, profile: "codex" } }]);
    // The keys go in the order the old editor sent them, so new keys land in the file in the same order.
    expect(JSON.stringify(lasso.sent[0]!.body)).toBe('{"budget":{"spend":4.5},"stages":{"plan":{"budget":{"rounds":null,"wallTime":"45m"},"prompt":"Plan it.","skills":["grilling","to-spec"]},"notify":{"with":{"status":"Done"}}},"profile":"codex"}');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("clears a Stage's fields with blanks, and sends a renamed Stage under its saved name", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.clear(within(plan).getByRole("textbox", { name: "Name" }));
    await user.type(within(plan).getByRole("textbox", { name: "Name" }), "think");
    await user.clear(within(plan).getByRole("textbox", { name: "Prompt" }));
    await user.clear(within(plan).getByRole("textbox", { name: "Skills" }));
    await user.clear(within(plan).getByRole("textbox", { name: "Artifact" }));
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]!.body).toEqual({ stages: { plan: { name: "think", prompt: null, skills: null, artifact: null } } });
  });

  it("adds a Runner Stage after any Stage, opened and focused, sent in the order as its fields", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(screen.getByRole("button", { name: "add a Stage after plan" }));
    await user.click(screen.getByRole("button", { name: "+ Runner Stage" }));
    const fresh = stage("New Stage");
    expect(fresh.className).toBe("stage k-runner open fresh");
    expect(document.activeElement).toBe(within(fresh).getByRole("textbox", { name: "Name" }));
    expect([...document.querySelectorAll(".rail > .stage .nm")].map((n) => n.textContent)).toEqual(["plan", "New Stage", "notify"]);
    expect(saveState()).toBe("Unsaved changes");
    await user.type(document.activeElement!, "review");
    await user.type(within(fresh).getByRole("textbox", { name: "Prompt" }), "Review it.");
    await user.type(within(fresh).getByRole("textbox", { name: "Feedback rounds" }), "3");
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(JSON.stringify(lasso.sent[0]!.body)).toBe('{"order":["plan",{"budget":{"rounds":3},"name":"review","prompt":"Review it."},"notify"]}');
  });

  it("adds an Action Stage with one field per param of the Action picked", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(screen.getByRole("button", { name: "add a Stage after notify" }));
    // Cancel adds nothing.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "add a Stage after notify" }));
    await user.click(screen.getByRole("button", { name: "+ Action Stage" }));
    const fresh = stage("New Stage");
    const action = within(fresh).getByRole("combobox", { name: "Action" });
    expect(document.activeElement).toBe(action);
    // Each Action once, a global one ahead of a repo's of the same name.
    expect(within(action).getAllByRole("option").map((o) => o.textContent)).toEqual(["pick one", "deploy", "transition"]);
    expect(within(fresh).getByText("no Action picked", { selector: ".sum" })).toBeTruthy();
    await user.selectOptions(action, "deploy");
    expect(within(fresh).getAllByRole("textbox").map((i) => i.getAttribute("name"))).toEqual(["env", "region"]);
    await user.type(within(fresh).getByRole("textbox", { name: "env" }), "prod");
    expect(within(fresh).getByText("deploy, env: prod, region: (blank)", { selector: ".sum" })).toBeTruthy();
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    // A param left blank is left out, so the server names it as missing.
    expect(lasso.sent[0]!.body).toEqual({ order: ["plan", "notify", { action: "deploy", with: { env: "prod" } }] });
  });

  it("swaps a saved Action Stage's params when another Action is picked, clearing the old ones", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(toggle("notify"));
    const notify = stage("notify");
    await user.selectOptions(within(notify).getByRole("combobox", { name: "Action" }), "deploy");
    await user.type(within(notify).getByRole("textbox", { name: "env" }), "prod");
    await user.type(within(notify).getByRole("textbox", { name: "region" }), "eu");
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]!.body).toEqual({ stages: { notify: { action: "deploy", with: { env: "prod", region: "eu", status: null } } } });
  });

  it("keeps an Action config lacks pickable, with the params the Stage has", async () => {
    fakeLasso();
    const { user } = await showForm({ ...PIPELINE, stages: [PIPELINE.stages[0]!, { kind: "action", name: "page", label: "ops", action: "pager", with: { team: "ops" } }] });
    await user.click(toggle("page"));
    const action = within(stage("page")).getByRole("combobox", { name: "Action" });
    expect(within(action).getAllByRole("option").map((o) => o.textContent)).toEqual(["pager (not in config.yaml)", "deploy", "transition"]);
    expect((within(stage("page")).getByRole("textbox", { name: "team" }) as HTMLInputElement).value).toBe("ops");
  });

  it("moves a Stage, sending the new order alone", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    expect(screen.queryByRole("button", { name: "move plan up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "move notify down" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "move notify up" }));
    expect([...document.querySelectorAll(".rail > .stage .nm")].map((n) => n.textContent)).toEqual(["notify", "plan"]);
    expect(saveState()).toBe("Unsaved changes");
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]!.body).toEqual({ order: ["notify", "plan"] });
  });

  it("removes a Stage on Save, with undo, and keeps at least one", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(screen.getByRole("button", { name: "remove plan" }));
    expect(stage("plan").className).toBe("stage k-runner removed");
    expect(within(stage("plan")).getByText("removed on Save")).toBeTruthy();
    expect([...document.querySelectorAll(".rail > .stage .station")].map((s) => s.textContent)).toEqual(["", "1"]);
    // The last Stage left cannot go.
    const last = screen.getByRole("button", { name: "remove notify" }) as HTMLButtonElement;
    expect(last.disabled).toBe(true);
    expect(last.title).toBe("a Pipeline keeps at least one Stage");
    await user.click(within(stage("plan")).getByRole("button", { name: "Undo" }));
    expect(stage("plan").className).toBe("stage k-runner");
    await user.click(screen.getByRole("button", { name: "remove notify" }));
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]!.body).toEqual({ order: ["plan"] });
  });

  it("drops a new Stage at once when it is removed, leaving nothing to send", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(screen.getByRole("button", { name: "add a Stage after plan" }));
    await user.click(screen.getByRole("button", { name: "+ Runner Stage" }));
    expect(screen.getByRole("button", { name: "remove the new Stage" }).title).toBe("drop this new Stage");
    await user.click(screen.getByRole("button", { name: "remove the new Stage" }));
    expect(screen.queryByText("New Stage")).toBeNull();
    await save(user);
    expect(notice().textContent).toBe("nothing changed");
    expect(lasso.sent).toEqual([]);
  });

  it("refuses a number field that holds something else, opening its Stage at the field, and shows a refused save", async () => {
    const lasso = fakeLasso();
    const { user, onSaved } = await showForm();
    await user.click(toggle("plan"));
    await user.type(within(stage("plan")).getByRole("textbox", { name: "Attempts" }), "two");
    await user.click(toggle("plan"));
    await save(user);
    expect(notice().textContent).toBe("attempts must be a number");
    expect(document.activeElement).toBe(within(stage("plan")).getByRole("textbox", { name: "Attempts" }));
    expect(lasso.sent).toEqual([]);

    lasso.state.refuse = "Stage plan: no profile named codex";
    await user.clear(document.activeElement!);
    await user.type(document.activeElement!, "2");
    await save(user);
    await waitFor(() => expect(notice().textContent).toBe("Stage plan: no profile named codex"));
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("a Stage's Agent Profile", () => {
  it("shows what the Stage runs, inherited from the Pipeline dropdown or default_profile, and each mode's line", async () => {
    fakeLasso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const button = within(stage("plan")).getByRole("button", { name: /^Agent Profile/ });
    expect([...button.children].map((s) => s.textContent)).toEqual(["inherit → claude-opus  ✎", "headless  claude · opus · effort default · auto (default)", "human     claude · opus · effort default · edits (default)"]);
    const dropdown = screen.getByRole("combobox", { name: "Agent Profile" });
    expect(within(dropdown).getAllByRole("option").map((o) => o.textContent)).toEqual(["config default (claude-opus)", "claude-opus", "codex"]);
    await user.selectOptions(dropdown, "codex");
    expect(button.children[0]!.textContent).toBe("inherit → codex  ✎");
  });

  it("opens the drawer on it, where Use and Inherit change the editor only, for Save to write", async () => {
    const lasso = fakeLasso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    await user.click(within(stage("plan")).getByRole("button", { name: /^Agent Profile/ }));
    const drawer = await screen.findByRole("dialog", { name: "Agent Profiles" });
    expect(await within(drawer).findByText("Stage plan of Pipeline default")).toBeTruthy();
    // The Pipeline editor has no repo, so the drawer opens on the global tab.
    expect(within(drawer).getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["global", "true"], ["app", "false"]]);
    await user.click(await within(drawer.querySelector<HTMLElement>('[data-role="profile-nav"]')!).findByText("codex"));
    await user.click(await within(drawer).findByRole("button", { name: "Use codex for plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lasso.sent).toEqual([]);
    const button = within(stage("plan")).getByRole("button", { name: /^Agent Profile/ });
    expect(button.children[0]!.textContent).toBe("codex  ✎  (unsaved)");
    expect(within(stage("plan")).getByText("codex, leaves spec", { selector: ".sum" })).toBeTruthy();
    expect(saveState()).toBe("Unsaved changes");
    await save(user);
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]!.body).toEqual({ stages: { plan: { profile: "codex" } } });
  });
});
