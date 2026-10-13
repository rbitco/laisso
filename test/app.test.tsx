// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG } from "../src/server/config.ts";
import type { BudgetView } from "../src/budget/budget.ts";
import type { ConfigFile, IntakeResult, PipelineListing, PipelineVersionView, TicketDetail, VersionView } from "../src/api/views.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { TickResult, TickStatus } from "../src/server/tick.ts";
import { App } from "../src/dashboard/app/App.tsx";
import { parseRoute } from "../src/dashboard/app/route.ts";
import { closeProfileDrawer } from "../src/dashboard/app/profiles/drawer.tsx";
import { showNotice } from "../src/dashboard/app/notice.tsx";
import { events } from "../src/dashboard/app/events.ts";

// The dashboard's frame as a person uses it (ADR 0012): the header's intake, Tick dot and Check now, the view links,
// and moving between the Ledger, a Ticket, Pipelines and Config by the page's hash.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const BUDGET: BudgetView = {
  rounds: { used: 0, limit: 3, source: "global" },
  attempts: { used: 1, limit: 3, source: "global" },
  wallTime: { used: 60_000, limit: 1_800_000, source: "global", limitText: "30m" },
  spend: { used: 0, limit: 5, source: "global" },
  ticket: { rounds: null, attempts: null, wallTime: null, spend: null },
};

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function ticket(id: string): TicketDetail {
  return {
    id, shortId: id.slice(-8), title: `Ticket ${id}`, reference: `APP-${id}`, origin: "tracker", body: null, repo: "app", branch: `app-${id}`, worktree: `/wt/${id}`,
    pipeline: "default", pipelineVersion: 2,
    stage: { name: "plan", kind: "runner", label: "plan", human: false, index: 0, total: 1, repeat: false, override: null },
    state: "active", flag: null, pr: null, display: { state: "quiet", label: "Quiet", why: "waiting" }, queue: null, triggers: [], budget: BUDGET,
    stages: [{ name: "plan", kind: "runner", label: "plan", human: false }],
    mirrorPending: false, createdAt: ago(60), updatedAt: ago(5), url: `http://lasso/#${id}`,
    session: null, sessions: [], pipelineDrift: "same", profiles: [],
  };
}

const DETECTED: Detection = {
  kind: "jira", reference: "APP-7", repo: { suggestion: null, choices: ["app", "web"] },
  pipeline: { suggestion: "default", choices: ["default", "frontend"], byRepo: { app: "default", web: "frontend" } },
  title: "Fix the login page", branch: null, notes: ["pick a repo to see the branch"],
};

const VERSION: PipelineVersionView = { name: "default", version: 2, createdAt: ago(180), live: 1, deleted: false, pipeline: { profile: null, budget: {}, stages: [] } };

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Lasso's /api: Tickets, one Pipeline and its Version 2, config, the Tick, the version notice, and intake; every request it was sent. */
function fakeLasso() {
  const sent: Sent[] = [];
  const state = {
    tickets: [ticket("A"), ticket("B")],
    tick: { tickSeconds: 30, lastTick: ago(10), nextTick: new Date(Date.now() + 20_000).toISOString(), running: false } as TickStatus,
    changes: [] as TickResult["changes"],
    branchExisted: false,
    held: null as Promise<void> | null,
    version: { version: "1.2.0", notice: { kind: "none" }, text: null } as VersionView,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    if (url === "/api/tickets" || url === "/api/tickets?all=1") {
      if (method === "GET") return json(state.tickets);
      return json({ ...ticket("N"), branch: "app-7-fix", branchExisted: state.branchExisted } satisfies IntakeResult);
    }
    const one = /^\/api\/tickets\/([^/]+)$/.exec(url);
    if (one) {
      if (state.held) await state.held;
      const t = state.tickets.find((x) => x.id === one[1]);
      return t ? json(t) : json({ error: `no Ticket matches ${one[1]}` }, 404);
    }
    if (url === "/api/tick") return json(state.tick);
    if (url === "/api/version") return json(state.version);
    if (url === "/api/check-now") return json({ at: ago(0), changes: state.changes } satisfies TickResult);
    if (url === "/api/intake/detect") return json(body.repo ? { ...DETECTED, notes: [`branch app-7 on ${body.repo}`] } : DETECTED);
    if (url === "/api/pipelines") return json([{ name: "default", file: "/p/default.yaml", profile: null, problem: null, stages: [] }] satisfies PipelineListing[]);
    if (url === "/api/pipelines/default/versions/2") return json(VERSION);
    if (url === "/api/config") return json({ file: "/c/config.yaml", text: "", config: DEFAULT_CONFIG, restart: [] } satisfies ConfigFile);
    if (url === "/api/actions") return json([]);
    return json({ error: `not found: ${url}` }, 404);
  });
  return { sent, state, gets: (route: string) => sent.filter((s) => s.method === "GET" && s.route === route).length };
}

const send = (kind: string, data: unknown = {}) => act(() => void events().dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(data) })));
const dot = () => document.querySelector<HTMLElement>('[data-role="tick-dot"]')!;
const notice = () => document.querySelector('[data-role="notice"]')!;
const section = (role: string) => document.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
const shownViews = () => ["ledger", "detail", "pipelines", "config"].filter((r) => !section(r).hidden);
const navOn = () => [...document.querySelectorAll("nav.views a.on")].map((a) => a.textContent);
const go = (hash: string) => act(() => void (location.hash = hash));

beforeEach(() => {
  showNotice("");
  location.hash = "";
});
afterEach(() => {
  act(() => closeProfileDrawer());
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Tick dot", () => {
  it("has no tooltip until the first status, then is idle, pulses while a Tick runs, and is red while Lasso is unreachable", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    expect(dot().className).toBe("dot tick-dot");
    expect(dot().hasAttribute("title")).toBe(false);
    send("hello", lasso.state.tick);
    expect(dot().className).toBe("dot tick-dot idle");
    expect(dot().getAttribute("title")).toBe("last tick 10s ago · next in 20s");
    expect(screen.getByRole("img", { name: "last tick 10s ago · next in 20s" })).toBe(dot());
    send("tick", { ...lasso.state.tick, running: true });
    expect(dot().className).toBe("dot tick-dot running");
    expect(dot().title).toBe("tick running");
    send("error");
    expect(dot().className).toBe("dot tick-dot down");
    expect(dot().title).toBe("lasso unreachable; reconnecting");
  });

  it("holds a fast Tick's pulse for one cycle, though the tooltip follows at once", async () => {
    const lasso = fakeLasso();
    render(<App />);
    send("hello", lasso.state.tick);
    // The Tick ran and ended between two events: a newer lastTick than a still status.
    send("tick", { ...lasso.state.tick, lastTick: ago(0) });
    expect(dot().className).toBe("dot tick-dot running");
    expect(dot().title).toMatch(/^last tick 0s ago/);
    await waitFor(() => expect(dot().className).toBe("dot tick-dot idle"), { timeout: 3000 });
  });

  it("moves its countdown each second", async () => {
    const lasso = fakeLasso();
    render(<App />);
    send("hello", lasso.state.tick);
    expect(dot().title).toBe("last tick 10s ago · next in 20s");
    await waitFor(() => expect(dot().title).toBe("last tick 11s ago · next in 19s"), { timeout: 2000 });
  });

  it("reads everything again when Lasso comes back after being unreachable", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    send("hello", lasso.state.tick);
    expect(lasso.gets("/api/tickets")).toBe(1);
    send("error");
    send("hello", lasso.state.tick);
    expect(dot().className).toBe("dot tick-dot idle");
    await waitFor(() => expect(lasso.gets("/api/tickets")).toBe(2));
  });
});

describe("the version notice", () => {
  const versionNotice = () => document.querySelector('[data-role="version-notice"]');

  it("shows in the header when Lasso has one, and follows it as it changes", async () => {
    const lasso = fakeLasso();
    lasso.state.version = { version: "1.2.0", notice: { kind: "available", version: "1.3.0" }, text: "v1.3.0 available: npm update -g @rbitco/lasso" };
    render(<App />);
    expect(await screen.findByText("v1.3.0 available: npm update -g @rbitco/lasso")).toBeTruthy();
    lasso.state.version = { version: "1.2.0", notice: { kind: "restart", version: "1.3.0" }, text: "v1.3.0 installed: restart lasso to use it" };
    send("version");
    expect(await screen.findByText("v1.3.0 installed: restart lasso to use it")).toBeTruthy();
    lasso.state.version = { version: "1.3.0", notice: { kind: "none" }, text: null };
    send("hello", lasso.state.tick);
    await waitFor(() => expect(versionNotice()).toBeNull());
  });

  it("is absent when there is nothing to say", async () => {
    fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    expect(versionNotice()).toBeNull();
  });
});

describe("Check now", () => {
  it("pulses the dot at once, runs a Tick, says what changed, and reads the page again", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    send("hello", lasso.state.tick);
    lasso.state.changes = [
      { ticket: "A", summary: "APP-A: review started" },
      { ticket: "B", summary: "APP-B: PR merged" },
    ];
    await userEvent.setup().click(screen.getByRole("button", { name: "Check now" }));
    expect(dot().className).toBe("dot tick-dot running");
    await waitFor(() => expect(notice().textContent).toBe("APP-A: review started; APP-B: PR merged"));
    expect(lasso.sent.filter((s) => s.method === "POST").map((s) => s.route)).toEqual(["/api/check-now"]);
    await waitFor(() => expect(lasso.gets("/api/tick")).toBe(1));
    await waitFor(() => expect(lasso.gets("/api/tickets")).toBe(2));
  });

  it("says nothing new when nothing changed", async () => {
    fakeLasso();
    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(notice().textContent).toBe("nothing new"));
  });
});

describe("intake", () => {
  it("detects what was pasted, asks for the repo, re-picks the Pipeline and notes with it, and adds the Ticket on Confirm", async () => {
    const lasso = fakeLasso();
    lasso.state.branchExisted = true;
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Intake" }), "APP-7");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const confirm = section("confirm");
    await within(confirm).findByText("jira APP-7");
    expect(lasso.sent.at(-1)).toMatchObject({ method: "POST", route: "/api/intake/detect", body: { input: "APP-7" } });
    expect(within(confirm).getByText("Fix the login page")).toBeTruthy();
    expect(within(confirm).getByText("pick a repo to see the branch")).toBeTruthy();
    const repo = within(confirm).getByRole("combobox", { name: "repo" }) as HTMLSelectElement;
    const pipeline = within(confirm).getByRole("combobox", { name: "pipeline" }) as HTMLSelectElement;
    expect([...repo.options].map((o) => o.textContent)).toEqual(["pick one", "app", "web"]);
    expect(repo.value).toBe("");
    expect(pipeline.value).toBe("default");

    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    expect(notice().textContent).toBe("repo is ambiguous: pick one");

    await user.selectOptions(repo, "web");
    expect(pipeline.value).toBe("frontend");
    await within(confirm).findByText("branch app-7 on web");
    expect(lasso.sent.at(-1)).toMatchObject({ route: "/api/intake/detect", body: { input: "APP-7", repo: "web" } });

    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(document.querySelector('[data-role="confirm"]')).toBeNull());
    expect(lasso.sent.find((s) => s.method === "POST" && s.route === "/api/tickets")!.body).toEqual({ input: "APP-7", repo: "web", pipeline: "frontend" });
    expect(notice().textContent).toBe("checked out existing branch app-7-fix");
    expect((screen.getByRole("textbox", { name: "Intake" }) as HTMLInputElement).value).toBe("");
    expect(location.hash).toBe("");
  });

  it("closes the confirm step on Cancel, and shows a refused detection", async () => {
    fakeLasso();
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Intake" }), "APP-7");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(document.querySelector('[data-role="confirm"]')).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "nothing to intake" }), { status: 400 }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(notice().textContent).toBe("nothing to intake"));
  });
});

describe("the page's views", () => {
  it("links Tickets, Pipelines and Config, marking the one shown", async () => {
    fakeLasso();
    render(<App />);
    expect(within(document.querySelector("nav.views")!).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Tickets", "#"],
      ["Pipelines", "#pipelines"],
      ["Config", "#config"],
    ]);
    expect(navOn()).toEqual(["Tickets"]);
    expect(shownViews()).toEqual(["ledger"]);
    go("#config");
    await screen.findByRole("heading", { level: 2, name: "Config" });
    expect(navOn()).toEqual(["Config"]);
    expect(shownViews()).toEqual(["config"]);
    expect(section("ledger-tools").hidden).toBe(true);
    go("#pipelines");
    await screen.findByText("Pick a Pipeline to edit it, or make a new one.");
    expect(navOn()).toEqual(["Pipelines"]);
    expect(shownViews()).toEqual(["pipelines"]);
  });

  it("opens a Pipeline Version from its link", async () => {
    const lasso = fakeLasso();
    location.hash = "#pipelines/default/v2";
    // jsdom announces a hash change a moment later; let it pass, as a page load would.
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("default v2");
    expect(lasso.gets("/api/pipelines/default/versions/2")).toBe(1);
    expect(navOn()).toEqual(["Pipelines"]);
  });

  it("keeps the Ledger until a Ticket arrives, then shows it with the Ledger as a sidebar, and goes back on ← all Tickets", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    let release!: () => void;
    lasso.state.held = new Promise((r) => (release = r));
    go("#A");
    expect(navOn()).toEqual(["Tickets"]);
    expect(shownViews()).toEqual(["ledger"]);
    await act(async () => release());
    await screen.findByRole("heading", { level: 2, name: "Ticket A" });
    expect(shownViews()).toEqual(["detail"]);
    expect(section("layout").className).toBe("dwrap open");
    expect(section("side").hidden).toBe(false);
    expect([...section("side").querySelectorAll<HTMLElement>(".qitem")].map((q) => q.dataset.id)).toEqual(["A", "B"]);
    lasso.state.held = null;

    await userEvent.setup().click(within(section("side")).getByRole("link", { name: "← all Tickets" }));
    await waitFor(() => expect(shownViews()).toEqual(["ledger"]));
    expect(section("layout").className).toBe("dwrap");
    expect(section("side").hidden).toBe(true);
    expect(section("side").childElementCount).toBe(0);
  });

  it("lists done and Abandoned Tickets when Show done and Abandoned is ticked", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show done and Abandoned" }));
    await waitFor(() => expect(lasso.gets("/api/tickets?all=1")).toBe(1));
  });
});

describe("the page's hash", () => {
  it("names the Ledger, a Ticket, Pipelines with a Pipeline or one of its Versions, or Config", () => {
    expect(parseRoute("")).toEqual({ view: "ledger" });
    expect(parseRoute("#01J9ZX")).toEqual({ view: "detail", id: "01J9ZX" });
    expect(parseRoute("#APP%2D7")).toEqual({ view: "detail", id: "APP-7" });
    expect(parseRoute("#pipelines")).toEqual({ view: "pipelines", name: null, version: null });
    expect(parseRoute("#pipelines/my%20flow")).toEqual({ view: "pipelines", name: "my flow", version: null });
    expect(parseRoute("#pipelines/default/v12")).toEqual({ view: "pipelines", name: "default", version: 12 });
    expect(parseRoute("#config")).toEqual({ view: "config" });
    // A malformed escape is taken as written.
    expect(parseRoute("#%E0")).toEqual({ view: "detail", id: "%E0" });
  });
});
