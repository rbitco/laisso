// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG, type Config } from "../src/server/config.ts";
import type { ActionListing, ConfigFile } from "../src/api/views.ts";
import { ConfigPage } from "../src/dashboard/app/config/ConfigPage.tsx";
import { events } from "../src/dashboard/app/events.ts";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";
import { ProfileDrawerHost } from "../src/dashboard/app/profiles/drawer.tsx";

// The Config page as a person uses it (ADR 0012): what it shows, what Save sends, and what it says back.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const FILE = "/home/me/.lasso/config.yaml";

/** A patch applied as config.yaml takes it: a null clears its key, which reads back as the default. */
function patched(config: Config, patch: Record<string, unknown>): Config {
  const merge = <T extends object>(now: T, defaults: T, changes: unknown = {}): T => {
    const set = changes as Record<string, unknown>;
    return Object.fromEntries(Object.entries(now).map(([k, v]) => [k, !(k in set) ? v : set[k] === null ? defaults[k as keyof T] : set[k]])) as T;
  };
  return { ...merge(config, DEFAULT_CONFIG, patch), budget: merge(config.budget, DEFAULT_CONFIG.budget, patch.budget), notifications: merge(config.notifications, DEFAULT_CONFIG.notifications, patch.notifications) };
}

/** A stand-in for Lasso's /api: config as it stands, every PATCH it was sent, and how it answers the next one. */
function fakeLasso(config: Config, actions: ActionListing[] = []) {
  const patches: unknown[] = [];
  const state = { config, refuse: null as string | null, restart: [] as string[] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (route: string, init: RequestInit = {}) => {
    if (route === "/api/actions") return json(actions);
    if (route === "/api/pipelines") return json([]);
    if (route !== "/api/config") return json({ error: "not found" }, 404);
    if (init.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      if (state.refuse) return json({ error: state.refuse }, 400);
      state.config = patched(state.config, JSON.parse(String(init.body)));
    }
    const file: ConfigFile = { file: FILE, text: "", config: state.config, restart: init.method === "PATCH" ? state.restart : [] };
    return json(file);
  });
  return { patches, state };
}

const notice = () => document.querySelector('[data-role="notice"]')!;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save changes" });

async function showPage(config: Config = DEFAULT_CONFIG, actions: ActionListing[] = []) {
  const lasso = fakeLasso(config, actions);
  render(<ConfigPage visit={1} />);
  await screen.findByText(FILE);
  return lasso;
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
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Config page's settings", () => {
  it("shows config's values, and saves only what changed", async () => {
    const lasso = await showPage();
    expect(field("Sessions at once").value).toBe("3");
    expect(field("Time per Session").value).toBe("30m");
    const user = userEvent.setup();
    await user.clear(field("Sessions at once"));
    await user.type(field("Sessions at once"), "4");
    await user.click(screen.getByLabelText("A Stage finished and the next waits for Start"));
    await user.click(save());
    await waitFor(() => expect(notice().textContent).toBe("saved"));
    expect(lasso.patches).toEqual([{ concurrency: 4, notifications: { gate: false } }]);
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
  });

  it("says when a saved setting applies only after a restart", async () => {
    const lasso = await showPage();
    lasso.state.restart = ["port"];
    const user = userEvent.setup();
    await user.clear(field("Port"));
    await user.type(field("Port"), "7500");
    await user.click(save());
    await waitFor(() => expect(notice().textContent).toBe("saved; port apply after a restart"));
    expect(lasso.patches).toEqual([{ port: 7500 }]);
  });

  it("clears a key left blank, back to its default", async () => {
    const lasso = await showPage({ ...DEFAULT_CONFIG, branch_prefix: "lasso/" });
    const user = userEvent.setup();
    await user.clear(field("Branch prefix"));
    await user.clear(field("Rounds per repeating Stage"));
    await user.click(save());
    await waitFor(() => expect(lasso.patches).toEqual([{ budget: { rounds: null }, branch_prefix: null }]));
  });

  it("sets where human Stages open, and clears the key when it goes back to auto", async () => {
    const lasso = await showPage({ ...DEFAULT_CONFIG, terminal: "tmux" });
    const select = screen.getByLabelText("Human Stages open in") as HTMLSelectElement;
    expect(select.value).toBe("tmux");
    const user = userEvent.setup();
    await user.selectOptions(select, "herdr");
    await user.click(save());
    await waitFor(() => expect(notice().textContent).toBe("saved"));
    await user.selectOptions(select, "auto");
    await user.click(save());
    await waitFor(() => expect(lasso.patches).toEqual([{ terminal: "herdr" }, { terminal: null }]));
  });

  it("marks the form unsaved while it differs from config, and not once it matches again", async () => {
    await showPage();
    const form = document.querySelector('[data-role="config-fields"]')!;
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    const user = userEvent.setup();
    await user.type(field("Spend per Ticket (USD)"), "0");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(form.classList.contains("dirty")).toBe(true);
    await user.type(field("Spend per Ticket (USD)"), "{Backspace}");
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    expect(form.classList.contains("dirty")).toBe(false);
  });

  it("shows the server's reason when it refuses a save, and keeps the edit", async () => {
    const lasso = await showPage();
    lasso.state.refuse = "config.yaml: tick: must be a positive number";
    const user = userEvent.setup();
    await user.clear(field("Check every (seconds)"));
    await user.type(field("Check every (seconds)"), "0");
    await user.click(save());
    await waitFor(() => expect(notice().textContent).toBe("config.yaml: tick: must be a positive number"));
    expect(field("Check every (seconds)").value).toBe("0");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends nothing while a number field holds something else, and puts the cursor there", async () => {
    const lasso = await showPage();
    const user = userEvent.setup();
    await user.type(field("Attempts per Stage"), "x");
    await user.click(save());
    expect(notice().textContent).toBe("attempts must be a number");
    expect(document.activeElement).toBe(field("Attempts per Stage"));
    expect(lasso.patches).toEqual([]);
  });

  it("says so when Save has nothing to send", async () => {
    const lasso = await showPage();
    await userEvent.setup().click(save());
    expect(notice().textContent).toBe("nothing changed");
    expect(lasso.patches).toEqual([]);
  });

  it("greys out the kinds of notification while notifications are off", async () => {
    await showPage();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Send notifications"));
    expect((screen.getByLabelText("A Ticket is Flagged") as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByLabelText("Send notifications"));
    expect((screen.getByLabelText("A Ticket is Flagged") as HTMLInputElement).disabled).toBe(false);
  });

  it("shows config another client saved in every field not being edited, and keeps the edits", async () => {
    const lasso = await showPage();
    lasso.state.config = { ...DEFAULT_CONFIG, concurrency: 6 };
    act(() => void events().dispatchEvent(new Event("config")));
    await waitFor(() => expect(field("Sessions at once").value).toBe("6"));

    const user = userEvent.setup();
    await user.clear(field("Keep finished Tickets (days)"));
    await user.type(field("Keep finished Tickets (days)"), "90");
    lasso.state.config = { ...DEFAULT_CONFIG, concurrency: 8 };
    act(() => void events().dispatchEvent(new Event("config")));
    await waitFor(() => expect(field("Sessions at once").value).toBe("8"));
    expect(field("Keep finished Tickets (days)").value).toBe("90");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // Save sends only the edit, so the other client's change stands.
    await user.click(save());
    await waitFor(() => expect(lasso.patches).toEqual([{ retention: 90 }]));
  });
});

describe("the Config page's read-only group", () => {
  it("lists config.yaml's Actions and repos, and says how to add one when there are none", async () => {
    const repos = { app: { path: "/code/app", tracker: "jira", project: "APP", pipeline: "default", actions: {}, profiles: {}, default_profile: null } } as unknown as Config["repos"];
    await showPage({ ...DEFAULT_CONFIG, repos }, [{ name: "deploy", repo: null, params: ["env"], timeout: "10m", run: "./deploy.sh" }]);
    expect(screen.getByText("./deploy.sh")).toBeTruthy();
    expect(screen.getByText("params: env")).toBeTruthy();
    expect(screen.getByText("global default")).toBeTruthy();
    expect(screen.getByText("/code/app")).toBeTruthy();
    cleanup();
    await showPage();
    expect(screen.getByText("None yet. Add one under actions: in config.yaml.")).toBeTruthy();
    expect(screen.getByText("None yet. Add one under repos: in config.yaml.")).toBeTruthy();
  });
});
