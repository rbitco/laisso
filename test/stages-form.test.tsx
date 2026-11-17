// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG, type Config } from "../src/server/config.ts";
import type { ActionListing, ConfigFile, PipelineView, StageFields } from "../src/api/views.ts";
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
  { name: "ci-green", repo: null, params: [], timeout: "5m", run: "gh pr checks" },
];

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  profiles: { "claude-opus": { runner: "claude", model: "opus" }, codex: { runner: "codex", model: "gpt-6-sol" } },
  default_profile: "claude-opus",
  // A repo with its own claude-opus, which a Stage, having no repo, does not open on.
  repos: { app: { path: "/code/app", tracker: "jira", project: "APP", pipeline: "default", actions: {}, profiles: { "claude-opus": { runner: "claude", model: "haiku" } }, default_profile: null } },
};

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Laisso's /api: config, its Actions, and every write it was sent; `refuse` makes the next write fail. */
function fakeLaisso() {
  const sent: Sent[] = [];
  const state = { refuse: null as string | null, breaks: null as string | null };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET" && url === "/api/actions") return json(ACTIONS);
    if (method === "GET" && url === "/api/config") return json({ file: "/c.yaml", text: "", config: CONFIG, restart: [] } satisfies ConfigFile);
    if (method === "GET" && url === "/api/pipelines") return json([]);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    if (state.refuse) return json({ error: state.refuse }, 400);
    if (state.breaks && !url.endsWith("?confirm=1")) return json({ error: state.breaks, breaks: [] }, 409);
    return json({});
  });
  return { sent, state };
}

const notice = () => document.querySelector('[data-role="notice"]')!;
/** A Stage on the line, by the name its head shows. */
const stage = (name: string) => screen.getByText(name, { selector: ".nm" }).closest<HTMLElement>(".stage")!;
const toggle = (name: string) => within(stage(name)).getAllByRole("button")[0]!;
const saveState = () => document.querySelector(".savebar .state")!.textContent;

async function showForm(pipeline: PipelineView = PIPELINE, reusedBy: LoadedPipeline["reusedBy"] = [], reuse: LoadedPipeline["reuse"] = null) {
  const onSaved = vi.fn();
  const file: LoadedPipeline = { name: "default", file: "/p/default.yaml", text: "", pipeline, problem: null, reuses: reuse !== null, reuse, parts: false, reusedBy };
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
    fakeLaisso();
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
    fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.click(within(plan).getByRole("checkbox", { name: "Human Stage: opens a terminal for you to work in" }));
    await user.selectOptions(within(plan).getByRole("combobox", { name: "Artifact" }), "none");
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
    const laisso = fakeLaisso();
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
    await user.selectOptions(within(plan).getByRole("combobox", { name: "Artifact" }), "pr-merged");
    await user.selectOptions(within(plan).getByRole("combobox", { name: "Artifact" }), "spec");
    await user.click(toggle("notify"));
    await user.clear(within(stage("notify")).getByRole("textbox", { name: "status" }));
    await user.type(within(stage("notify")).getByRole("textbox", { name: "status" }), "Done");
    await save(user);

    await waitFor(() => expect(notice().textContent).toBe("saved default"));
    expect(laisso.sent).toEqual([{ method: "PATCH", route: "/api/pipelines/default", body: { budget: { spend: 4.5 }, stages: { plan: { prompt: "Plan it.", skills: ["grilling", "to-spec"], budget: { rounds: null, wallTime: "45m" } }, notify: { with: { status: "Done" } } }, profile: "codex" } }]);
    // The keys go in the order the old editor sent them, so new keys land in the file in the same order.
    expect(JSON.stringify(laisso.sent[0]!.body)).toBe('{"budget":{"spend":4.5},"stages":{"plan":{"budget":{"rounds":null,"wallTime":"45m"},"prompt":"Plan it.","skills":["grilling","to-spec"]},"notify":{"with":{"status":"Done"}}},"profile":"codex"}');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("clears a Stage's fields with blanks, and sends a renamed Stage under its saved name", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.clear(within(plan).getByRole("textbox", { name: "Name" }));
    await user.type(within(plan).getByRole("textbox", { name: "Name" }), "think");
    await user.clear(within(plan).getByRole("textbox", { name: "Prompt" }));
    await user.clear(within(plan).getByRole("textbox", { name: "Skills" }));
    await user.selectOptions(within(plan).getByRole("combobox", { name: "Artifact" }), "none");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { name: "think", prompt: null, skills: null, artifact: null } } });
  });

  it("adds a Runner Stage after any Stage, opened and focused, sent in the order as its fields", async () => {
    const laisso = fakeLaisso();
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
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(JSON.stringify(laisso.sent[0]!.body)).toBe('{"order":["plan",{"budget":{"rounds":3},"name":"review","prompt":"Review it."},"notify"]}');
  });

  it("adds an Action Stage with one field per param of the Action picked", async () => {
    const laisso = fakeLaisso();
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
    expect(within(action).getAllByRole("option").map((o) => o.textContent)).toEqual(["pick one", "ci-green", "deploy", "transition"]);
    expect(within(fresh).getByText("no Action picked", { selector: ".sum" })).toBeTruthy();
    await user.selectOptions(action, "deploy");
    expect(within(fresh).getAllByRole("textbox").map((i) => i.getAttribute("name"))).toEqual(["env", "region"]);
    await user.type(within(fresh).getByRole("textbox", { name: "env" }), "prod");
    expect(within(fresh).getByText("deploy, env: prod, region: (blank)", { selector: ".sum" })).toBeTruthy();
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    // A param left blank is left out, so the server names it as missing.
    expect(laisso.sent[0]!.body).toEqual({ order: ["plan", "notify", { action: "deploy", with: { env: "prod" } }] });
  });

  it("swaps a saved Action Stage's params when another Action is picked, clearing the old ones", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("notify"));
    const notify = stage("notify");
    await user.selectOptions(within(notify).getByRole("combobox", { name: "Action" }), "deploy");
    await user.type(within(notify).getByRole("textbox", { name: "env" }), "prod");
    await user.type(within(notify).getByRole("textbox", { name: "region" }), "eu");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { notify: { action: "deploy", with: { env: "prod", region: "eu", status: null } } } });
  });

  it("keeps an Action config lacks pickable, with the params the Stage has", async () => {
    fakeLaisso();
    const { user } = await showForm({ ...PIPELINE, stages: [PIPELINE.stages[0]!, { kind: "action", name: "page", label: "ops", action: "pager", with: { team: "ops" } }] });
    await user.click(toggle("page"));
    const action = within(stage("page")).getByRole("combobox", { name: "Action" });
    expect(within(action).getAllByRole("option").map((o) => o.textContent)).toEqual(["pager (not in config.yaml)", "ci-green", "deploy", "transition"]);
    expect((within(stage("page")).getByRole("textbox", { name: "team" }) as HTMLInputElement).value).toBe("ops");
  });

  it("moves a Stage, sending the new order alone", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    expect(screen.queryByRole("button", { name: "move plan up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "move notify down" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "move notify up" }));
    expect([...document.querySelectorAll(".rail > .stage .nm")].map((n) => n.textContent)).toEqual(["notify", "plan"]);
    expect(saveState()).toBe("Unsaved changes");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ order: ["notify", "plan"] });
  });

  it("removes a Stage on Save, with undo, and keeps at least one", async () => {
    const laisso = fakeLaisso();
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
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ order: ["plan"] });
  });

  it("drops a new Stage at once when it is removed, leaving nothing to send", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(screen.getByRole("button", { name: "add a Stage after plan" }));
    await user.click(screen.getByRole("button", { name: "+ Runner Stage" }));
    expect(screen.getByRole("button", { name: "remove the new Stage" }).title).toBe("drop this new Stage");
    await user.click(screen.getByRole("button", { name: "remove the new Stage" }));
    expect(screen.queryByText("New Stage")).toBeNull();
    await save(user);
    expect(notice().textContent).toBe("nothing changed");
    expect(laisso.sent).toEqual([]);
  });

  it("refuses a number field that holds something else, opening its Stage at the field, and shows a refused save", async () => {
    const laisso = fakeLaisso();
    const { user, onSaved } = await showForm();
    await user.click(toggle("plan"));
    await user.type(within(stage("plan")).getByRole("textbox", { name: "Attempts" }), "two");
    await user.click(toggle("plan"));
    await save(user);
    expect(notice().textContent).toBe("attempts must be a number");
    expect(document.activeElement).toBe(within(stage("plan")).getByRole("textbox", { name: "Attempts" }));
    expect(laisso.sent).toEqual([]);

    laisso.state.refuse = "Stage plan: no profile named codex";
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
    fakeLaisso();
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
    const laisso = fakeLaisso();
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
    expect(laisso.sent).toEqual([]);
    const button = within(stage("plan")).getByRole("button", { name: /^Agent Profile/ });
    expect(button.children[0]!.textContent).toBe("codex  ✎  (unsaved)");
    expect(within(stage("plan")).getByText("codex, leaves spec", { selector: ".sum" })).toBeTruthy();
    expect(saveState()).toBe("Unsaved changes");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { profile: "codex" } } });
  });
});

describe("the Artifact picker", () => {
  const artifact = (card: HTMLElement) => within(card).getByRole("combobox", { name: "Artifact" }) as HTMLSelectElement;

  it("lists the built-in Artifacts, a file, and config's Actions as checks, keeping a saved one config lacks", async () => {
    fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const picker = artifact(stage("plan"));
    expect(picker.value).toBe("spec");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["none", "spec", "tracker-spec", "tracker-comment", "commits-on-branch", "pr-exists", "pr-review", "pr-merged", "file in the worktree", "action ci-green", "action deploy", "action transition"]);
    expect([...picker.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Built in", "Check Actions"]);
  });

  it("shows a field per param of the Action picked and saves it as action and with", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.selectOptions(artifact(plan), "action deploy");
    expect(within(plan).getByText("claude-opus, leaves action deploy", { selector: ".sum" })).toBeTruthy();
    await user.type(within(plan).getByRole("textbox", { name: "env" }), "prod");
    // A param left blank is refused before anything is sent, and its field is focused.
    await save(user);
    expect(notice().textContent).toBe("action deploy needs region");
    expect(laisso.sent).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(within(plan).getByRole("textbox", { name: "region" })));
    await user.type(within(plan).getByRole("textbox", { name: "region" }), " eu ");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { artifact: { action: "deploy", with: { env: "prod", region: "eu" } } } } });
  });

  it("saves an Action with no params as one line", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.selectOptions(artifact(plan), "action ci-green");
    expect(within(plan).queryByRole("textbox", { name: "env" })).toBeNull();
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { artifact: "action ci-green" } } });
  });

  it("saves a file Artifact by its path, and refuses one with none", async () => {
    const laisso = fakeLaisso();
    const { user } = await showForm();
    await user.click(toggle("plan"));
    const plan = stage("plan");
    await user.selectOptions(artifact(plan), "file");
    await save(user);
    expect(notice().textContent).toBe("a file Artifact needs a path");
    await user.type(within(plan).getByRole("textbox", { name: "Path" }), "NOTES.md");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { artifact: "file NOTES.md" } } });
  });

  it("opens a saved check Action and its params as written, sending nothing until they change", async () => {
    const laisso = fakeLaisso();
    const plan = { ...PIPELINE.stages[0]!, artifact: "action deploy", artifactWith: { env: "prod", region: "eu" } } as PipelineView["stages"][number];
    const { user } = await showForm({ ...PIPELINE, stages: [plan, PIPELINE.stages[1]!] });
    await user.click(toggle("plan"));
    const card = stage("plan");
    expect(artifact(card).value).toBe("action deploy");
    expect((within(card).getByRole("textbox", { name: "region" }) as HTMLInputElement).value).toBe("eu");
    await save(user);
    expect(notice().textContent).toBe("nothing changed");
    await user.clear(within(card).getByRole("textbox", { name: "region" }));
    await user.type(within(card).getByRole("textbox", { name: "region" }), "us");
    await save(user);
    await waitFor(() => expect(laisso.sent).toHaveLength(1));
    expect(laisso.sent[0]!.body).toEqual({ stages: { plan: { artifact: { action: "deploy", with: { env: "prod", region: "us" } } } } });
  });
});

describe("a field save that breaks a reusing Pipeline (LASSO-219)", () => {
  it("asks first, listing what breaks; Cancel leaves it unsaved, Save anyway sends it confirmed", async () => {
    const laisso = fakeLaisso();
    laisso.state.breaks = "Saving default breaks 1 Pipeline: bug-fix: stage 1 (use default.plan): default has no Stage named plan";
    const { user, onSaved } = await showForm();
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent Profile" }), "codex");
    await save(user);
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(laisso.state.breaks)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveState()).toBe("Unsaved changes");
    await save(user);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(laisso.sent.map((x) => x.route)).toEqual(["/api/pipelines/default", "/api/pipelines/default", "/api/pipelines/default?confirm=1"]);
  });
});

describe("a Stage other Pipelines reuse (LASSO-220)", () => {
  it("carries a marker naming them, and Stages nobody takes carry none", async () => {
    fakeLaisso();
    await showForm(PIPELINE, [{ pipeline: "bug-fix", stages: ["plan", "notify"] }, { pipeline: "codex-review", stages: ["plan"] }]);
    expect(within(stage("plan")).getByText("↗ bug-fix, codex-review")).toBeTruthy();
    expect(within(stage("notify")).getByText("↗ bug-fix")).toBeTruthy();
    cleanup();
    fakeLaisso();
    await showForm();
    expect(document.querySelector('[data-role="reused-by"]')).toBeNull();
  });
});

describe("a Pipeline that reuses Stages, in the field editor (LASSO-222)", () => {
  const runnerStage = (name: string, prompt: string, extra: Partial<Extract<StageFields, { kind: "runner" }>> = {}): StageFields => ({ kind: "runner", name, label: name, prompt, skills: [], profile: null, human: false, advance: true, artifact: null, repeat: null, budget: {}, ...extra });
  const PLAN = runnerStage("plan", "Plan it.", { human: true });
  const IMPLEMENT = runnerStage("implement", "Carry it out.", { budget: { rounds: 3 } });
  const NOTIFY: StageFields = { kind: "action", name: "notify", label: "Review", action: "transition", with: { status: "Review" } };
  const SMOKE = runnerStage("smoke", "Run it.");
  const changedImplement = { ...IMPLEMENT, prompt: "Carry it out.\n\nTest first." } as StageFields;
  const REUSE: NonNullable<LoadedPipeline["reuse"]> = [
    { stage: PLAN, origin: { pipeline: "default", stage: "plan", how: "include" }, source: PLAN, skipped: true },
    { stage: changedImplement, origin: { pipeline: "default", stage: "implement", how: "include" }, source: IMPLEMENT, skipped: false },
    { stage: SMOKE, origin: null, source: null, skipped: false },
    { stage: NOTIFY, origin: { pipeline: "default", stage: "notify", how: "use" }, source: NOTIFY, skipped: false },
  ];
  const BUG_FIX: PipelineView = { profile: null, budget: {}, stages: [changedImplement, SMOKE, NOTIFY] };
  const show = () => showForm(BUG_FIX, [], REUSE);
  const head = (name: string) => stage(name).querySelector("h3")!;

  it("tags each copied Stage with its source and how many fields it changes, and shows a skipped one greyed with Keep", async () => {
    fakeLaisso();
    await show();
    expect(within(head("implement")).getByText("from default")).toBeTruthy();
    expect(within(head("implement")).getByText("1 changed")).toBeTruthy();
    expect(within(head("notify")).getByText("use default")).toBeTruthy();
    expect(within(head("notify")).queryByText(/changed/)).toBeNull();
    expect(head("smoke").querySelector('[data-role="reuse-tag"]')).toBeNull();
    const plan = stage("plan");
    expect(plan.className).toContain("skipped");
    expect(plan.querySelector(".station")!.textContent).toBe("");
    expect(within(plan).getByText("skipped from default")).toBeTruthy();
    expect(within(plan).getByRole("button", { name: "Keep" })).toBeTruthy();
    expect([...document.querySelectorAll(".rail .station")].map((st) => st.textContent)).toEqual(["", "1", "2", "3"]);
    // Moving and adding among reuse entries waits for LASSO-223.
    expect(document.querySelector('[data-role="move-up"], .add-stage')).toBeNull();
  });

  it("shows the source's value under each unchanged field, and Reset puts a changed one back", async () => {
    const laisso = fakeLaisso();
    const { user } = await show();
    await user.click(toggle("implement"));
    const implement = stage("implement");
    const note = (label: string) => within(implement).getByRole("textbox", { name: label }).closest(".noted")!.querySelector(".reuse-note")!;
    expect(note("Feedback rounds").textContent).toBe("from default: 3");
    expect(note("Skills").textContent).toBe("from default: none");
    expect(note("Prompt").textContent).toBe("changedReset to default");
    await user.clear(within(implement).getByRole("textbox", { name: "Feedback rounds" }));
    await user.type(within(implement).getByRole("textbox", { name: "Feedback rounds" }), "5");
    expect(within(head("implement")).getByText("2 changed")).toBeTruthy();
    await user.click(within(note("Prompt") as HTMLElement).getByRole("button", { name: "Reset to default" }));
    expect((within(implement).getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("Carry it out.");
    expect(note("Prompt").textContent).toBe("from default: Carry it out.");
    await user.click(toggle("notify"));
    await user.clear(within(stage("notify")).getByRole("textbox", { name: "status" }));
    await user.type(within(stage("notify")).getByRole("textbox", { name: "status" }), "Done");
    expect(within(stage("notify")).getByRole("textbox", { name: "status" }).closest(".noted")!.querySelector(".reuse-note")!.textContent).toBe("changedReset to default");
    await save(user);
    await waitFor(() => expect(notice().textContent).toBe("saved default"));
    expect(laisso.sent).toEqual([{ method: "PATCH", route: "/api/pipelines/default", body: { stages: { implement: { prompt: "Carry it out.", budget: { rounds: 5 } }, notify: { with: { status: "Done" } } } } }]);
  });

  it("✕ skips an included Stage, removes a use or an own Stage, and Keep copies a skipped one again", async () => {
    const laisso = fakeLaisso();
    const { user } = await show();
    const remove = (name: string) => within(head(name)).getByRole("button", { name: "remove " + name });
    expect(remove("implement").title).toBe("skip this Stage of default on Save");
    expect(within(head("notify")).getByRole("button", { name: "remove notify" }).title).toBe("remove this use on Save");
    expect(remove("smoke").title).toBe("remove this Stage on Save");
    await user.click(remove("implement"));
    expect(within(head("implement")).getByText("skipped on Save")).toBeTruthy();
    await user.click(remove("smoke"));
    expect(within(head("smoke")).getByText("removed on Save")).toBeTruthy();
    await user.click(within(stage("plan")).getByRole("button", { name: "Keep" }));
    expect(stage("plan").className).not.toContain("removed");
    await save(user);
    await waitFor(() => expect(notice().textContent).toBe("saved default"));
    expect(laisso.sent).toEqual([{ method: "PATCH", route: "/api/pipelines/default", body: { order: ["plan", "notify"] } }]);
    cleanup();
    render(<Overlays />);
    const again = fakeLaisso();
    const second = await show();
    await second.user.click(within(head("notify")).getByRole("button", { name: "remove notify" }));
    await save(second.user);
    await waitFor(() => expect(again.sent).toEqual([{ method: "PATCH", route: "/api/pipelines/default", body: { order: ["implement", "smoke"] } }]));
  });
});
