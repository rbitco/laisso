// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG, type Config, type ProfileConfig } from "../src/server/config.ts";
import type { ConfigFile, PipelineListing } from "../src/api/views.ts";
import { ProfileDrawer, type DrawerOptions } from "../src/dashboard/app/profiles/ProfileDrawer.tsx";
import { closeProfileDrawer, openProfileDrawer, ProfileDrawerHost } from "../src/dashboard/app/profiles/drawer.tsx";
import { ConfigPage } from "../src/dashboard/app/config/ConfigPage.tsx";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";

// The Agent Profile drawer as a person uses it (ADR 0012): what it shows, what each action writes, and how it closes.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const FILE = "/home/me/.lasso/config.yaml";

const OPUS: ProfileConfig = { runner: "claude", model: "opus", effort: "high" };
const CODEX: ProfileConfig = { runner: "codex", model: "gpt-6-sol" };

function configWith(over: Partial<Config> = {}): Config {
  const repo = { path: "/code/app", tracker: "jira" as const, project: "APP", pipeline: "default", actions: {}, profiles: {}, default_profile: null };
  return {
    ...DEFAULT_CONFIG,
    profiles: { "claude-opus": OPUS, codex: CODEX },
    default_profile: "claude-opus",
    repos: { app: { ...repo, profiles: { "claude-opus": { runner: "claude", model: "haiku" } } }, web: { ...repo, path: "/code/web" } },
    ...over,
  };
}

const PIPELINES: PipelineListing[] = [
  { name: "default", file: "/p/default.yaml", profile: null, problem: null, stages: [{ name: "plan", kind: "runner", label: "plan", profile: "codex" }, { name: "implement", kind: "runner", label: "implement", profile: null }] },
];

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Lasso's /api: config as it stands, every write it was sent, and the profiles a delete must confirm. */
function fakeLasso(config: Config = configWith()) {
  const sent: Sent[] = [];
  const state = { config, inUse: new Set<string>() };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const file = (): ConfigFile => ({ file: FILE, text: "", config: state.config, restart: [] });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const [route, query] = url.split("?");
    if (method === "GET" && route === "/api/config") return json(file());
    if (method === "GET" && route === "/api/actions") return json([]);
    if (method === "GET" && route === "/api/pipelines") return json(PIPELINES);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    const c = structuredClone(state.config);
    const m = /^\/api(?:\/repos\/([^/]+))?\/profiles\/([^/]+)$/.exec(route);
    if (m) {
      const [repo, name] = [m[1] && decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const profiles = repo ? c.repos[repo].profiles : c.profiles;
      if (method === "PUT") profiles[name] = body.profile;
      if (method === "DELETE") {
        if (state.inUse.has(name) && query !== "confirm=1") return json({ error: `${name} is named by default/plan; their next Sessions are Flagged once it is gone`, usedBy: ["default/plan"], confirm: true }, 409);
        delete profiles[name];
      }
    } else if (method === "PATCH" && route === "/api/config") c.default_profile = body.default_profile;
    else if (method === "PATCH" && route.startsWith("/api/repos/")) c.repos[decodeURIComponent(route.slice("/api/repos/".length))].default_profile = body.default_profile;
    else return json({ error: "not found" }, 404);
    state.config = c;
    return json(file());
  });
  return { sent, state };
}

const drawer = () => screen.getByRole("dialog", { name: "Agent Profiles" });
const tab = (name: string) => within(drawer()).getByRole("tab", { name });
const nav = () => drawer().querySelector("nav")!;
// The shared fields, above the per-mode blocks.
const shared = () => drawer().querySelector<HTMLElement>('[data-role="profile-fields"] > .fields')!;
const sharedField = (label: string) => within(shared()).getByLabelText(label) as HTMLInputElement;

async function showDrawer(name: string | null, options: DrawerOptions = {}, config?: Config) {
  const lasso = fakeLasso(config);
  const onClose = vi.fn();
  render(<ProfileDrawer start={name} options={options} onClose={onClose} />);
  await within(await screen.findByRole("dialog")).findByRole("button", { name: "Save" });
  return { ...lasso, onClose };
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
  act(() => closeProfileDrawer());
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the profile drawer's scope tabs", () => {
  it("shows a tab for global and each repo with its own, edits the one chosen, and starts on the asked-for repo", async () => {
    await showDrawer("claude-opus");
    expect(within(drawer()).getAllByRole("tab").map((t) => t.textContent)).toEqual(["global", "app"]);
    expect(tab("global").getAttribute("aria-selected")).toBe("true");
    expect(sharedField("model").value).toBe("opus");
    expect(screen.getByText("overridden in app: that repo runs its own")).toBeTruthy();
    expect(screen.getByText("inherited by default/implement")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(tab("app"));
    expect(tab("app").getAttribute("aria-selected")).toBe("true");
    expect(sharedField("model").value).toBe("haiku");
    expect(screen.getByText("repo app's own claude-opus: it replaces the global one whole for app's Tickets")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove override" })).toBeTruthy();

    cleanup();
    await showDrawer("claude-opus", { scope: "app", context: "Stage plan of Ticket APP-1" });
    expect(tab("app").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Stage plan of Ticket APP-1")).toBeTruthy();
  });

  it("copies the global profile into a repo with Override for repo…, then opens that repo's tab", async () => {
    const lasso = await showDrawer("claude-opus");
    await userEvent.setup().selectOptions(within(drawer()).getByLabelText("Override for repo"), "web");
    await waitFor(() => expect(tab("web").getAttribute("aria-selected")).toBe("true"));
    expect(lasso.sent).toEqual([{ method: "PUT", route: "/api/repos/web/profiles/claude-opus", body: { profile: OPUS, create: true } }]);
  });

  it("asks before leaving a tab with unsaved edits, and stays when told no", async () => {
    await showDrawer("claude-opus");
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    await user.type(sharedField("model"), "-x");
    await user.click(tab("app"));
    expect(ask).toHaveBeenCalledWith("Drop the unsaved changes to claude-opus?");
    expect(tab("global").getAttribute("aria-selected")).toBe("true");
    expect(sharedField("model").value).toBe("opus-x");
  });
});

describe("the profile drawer's Save", () => {
  it("writes the open tab's profile, leaving blanks and fields its Runner ignores out", async () => {
    const lasso = await showDrawer("codex");
    const user = userEvent.setup();
    await user.selectOptions(within(shared()).getByLabelText("permission"), "full");
    await user.type(within(shared()).getByLabelText("args"), "--search  --fast");
    await user.type(within(screen.getByText("human only").parentElement!).getByLabelText("model"), "gpt-5.5");
    await user.selectOptions(within(shared()).getByLabelText("runner"), "pi");
    // Pi has no permission layer, so the field shows n/a and the save leaves it out.
    expect(within(shared()).getByText("n/a on Pi")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lasso.sent).toHaveLength(1));
    expect(lasso.sent[0]).toEqual({ method: "PUT", route: "/api/profiles/codex", body: { profile: { runner: "pi", model: "gpt-6-sol", args: ["--search", "--fast"], human: { model: "gpt-5.5" } } } });
  });

  it("saves a repo's tab to that repo, and tells whoever opened the drawer", async () => {
    const onChange = vi.fn();
    const lasso = await showDrawer("claude-opus", { scope: "app", onChange });
    const user = userEvent.setup();
    await user.clear(sharedField("model"));
    await user.type(sharedField("model"), "sonnet");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(lasso.sent).toEqual([{ method: "PUT", route: "/api/repos/app/profiles/claude-opus", body: { profile: { runner: "claude", model: "sonnet" } } }]);
    expect(onChange.mock.calls[0][0].repos.app.profiles["claude-opus"]).toEqual({ runner: "claude", model: "sonnet" });
  });

  it("warns on a pair the Runner does not honour", async () => {
    await showDrawer("claude-opus");
    await userEvent.setup().type(sharedField("model"), "-haiku");
    expect(screen.getByText("⚠ Claude runs Haiku in Manual mode, not auto (headless Sessions)")).toBeTruthy();
  });

  it("makes a profile the default, and marks it", async () => {
    const lasso = await showDrawer("codex");
    await userEvent.setup().click(screen.getByRole("button", { name: "Make default" }));
    await screen.findByText("default profile");
    expect(lasso.sent).toEqual([{ method: "PATCH", route: "/api/config", body: { default_profile: "codex" } }]);
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
  });
});

describe("the profile drawer's Delete", () => {
  it("asks twice, then, refused while the profile is in use, says what names it and deletes on the next press", async () => {
    const lasso = await showDrawer("codex");
    lasso.state.inUse.add("codex");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(lasso.sent).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete for sure" }));
    await screen.findByText("codex is named by default/plan; their next Sessions are Flagged once it is gone");
    expect(lasso.sent).toEqual([{ method: "DELETE", route: "/api/profiles/codex", body: null }]);
    await user.click(screen.getByRole("button", { name: "Delete anyway" }));
    // Gone, the drawer moves to the default profile.
    await waitFor(() => expect(within(drawer()).getByRole("heading", { level: 2 }).textContent).toBe("claude-opus"));
    expect(lasso.sent[1]).toEqual({ method: "DELETE", route: "/api/profiles/codex?confirm=1", body: null });
    expect(within(nav()).queryByText("codex")).toBeNull();
  });

  it("will not delete the default profile", async () => {
    await showDrawer("claude-opus");
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("leaving the profile drawer", () => {
  it("closes on Close and Escape, asking first while edits are unsaved", async () => {
    const { onClose } = await showDrawer("claude-opus");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);

    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.type(sharedField("model"), "x");
    await user.keyboard("{Escape}");
    expect(ask).toHaveBeenCalledWith("Drop the unsaved changes to claude-opus?");
    expect(onClose).toHaveBeenCalledTimes(2);
    ask.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("the drawer opened from elsewhere", () => {
  it("offers the opener's choices for the open profile, runs one, and closes", async () => {
    fakeLasso();
    const used: string[] = [];
    act(() =>
      openProfileDrawer("claude-opus", {
        context: "Stage plan of Pipeline default",
        extra: (name) => ({
          role: "stage-profile-choice",
          why: "sets this Stage in the editor",
          choices: [
            { role: "profile-use", primary: true, label: `Use ${name} for plan`, act: () => used.push(name) },
            { role: "profile-clear", label: "Clear override", hidden: true, act: () => used.push("cleared") },
          ],
        }),
      }),
    );
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole("navigation")).getByText("codex"));
    expect(screen.queryByRole("button", { name: "Clear override" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use codex for plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(used).toEqual(["codex"]);
  });

  it("keeps the drawer open and shows why when the opener's choice is refused", async () => {
    fakeLasso();
    act(() =>
      openProfileDrawer("codex", {
        extra: (name) => ({ role: "ticket-profile-choice", choices: [{ role: "profile-use", label: `Use ${name}`, act: () => Promise.reject(new Error("no Stage named plan")) }] }),
      }),
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Use codex" }));
    await screen.findByText("no Stage named plan");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens from a Config tile, and the tile shows what a save there wrote", async () => {
    fakeLasso();
    render(<ConfigPage visit={1} />);
    const tile = await screen.findByRole("button", { name: "edit Agent Profile codex" });
    expect(within(tile).getByText("used by default/plan")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "edit Agent Profile claude-opus" })).getByText("default")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(tile);
    await user.type(sharedField("model"), "-2");
    await user.click(within(drawer()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(tile).getByText(/^codex · gpt-6-sol-2/)).toBeTruthy());
  });
});
