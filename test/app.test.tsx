// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG } from "../src/server/config.ts";
import type { BudgetView } from "../src/budget/budget.ts";
import type { ConfigFile, PrListsStatus, PrListsView, Reviewer, IntakeResult, PipelineListing, PipelineVersionView, TicketDetail, VersionView, Health } from "../src/api/views.ts";
import type { Detection } from "../src/intake/detect.ts";
import type { TickResult, TickStatus } from "../src/server/tick.ts";
import { App } from "../src/dashboard/app/App.tsx";
import { parseRoute, ticketHref } from "../src/dashboard/app/route.ts";
import { closeProfileDrawer } from "../src/dashboard/app/profiles/drawer.tsx";
import { showNotice } from "../src/dashboard/app/notice.tsx";
import { events } from "../src/dashboard/app/events.ts";

// The dashboard's frame as a person uses it (ADR 0012): the header's intake, the nav's view links, Tick dot and Check now,
// and moving between the Ledger, a Ticket, Pipelines and Config by the page's hash.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

// jsdom has <dialog> but not its modal methods; these stand in for what the confirm step uses.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const BUDGET: BudgetView = {
  rounds: { used: 0, limit: 3, source: "global" },
  attempts: { used: 1, limit: 3, source: "global" },
  wallTime: { used: 60_000, limit: 1_800_000, source: "global", limitText: "30m" },
  spend: { used: 0, limit: 5, source: "global" },
  routes: { value: 3, source: "global" },
  ticket: { rounds: null, attempts: null, wallTime: null, spend: null, routes: null },
};

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function ticket(id: string): TicketDetail {
  return {
    id, shortId: id.slice(-8), title: `Ticket ${id}`, reference: `APP-${id}`, name: null, label: `APP-${id}`, origin: "tracker", body: null, repo: "app", branch: `app-${id}`, worktree: `/wt/${id}`, check: null,
    pipeline: "default", pipelineVersion: 2,
    stage: { name: "plan", kind: "runner", label: "plan", human: false, index: 0, total: 1, repeat: false, override: null },
    state: "active", flag: null, prs: [], display: { state: "quiet", label: "Quiet", why: "waiting" }, queue: null, triggers: [], budget: BUDGET,
    stages: [{ name: "plan", kind: "runner", label: "plan", human: false, skippedAt: null }],
    mirrorPending: false, createdAt: ago(60), updatedAt: ago(5), url: `http://lasso/#${id}`,
    session: null, sessions: [], pipelineDrift: "same", profiles: [], send: null, markDone: null, visit: null, visits: [], arcs: [], upgrades: [],
  };
}

const DETECTED: Detection = {
  kind: "jira", reference: "APP-7", repo: { suggestion: null, choices: ["app", "web"] },
  pipeline: { suggestion: "default", choices: ["default", "frontend"], byRepo: { app: "default", web: "frontend" } },
  title: "Fix the login page", branch: null, notes: ["pick a repo to see the branch"],
};

/** One of each kind of reviewer, worst first: a person with a picture, a required team, a required hidden team, and a person without one. */
const REVIEWERS: Reviewer[] = [
  { name: "sam", kind: "person", state: "changes", required: false, initials: "SA", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
  { name: "rbitco/web-platform", kind: "team", state: "requested", required: true, initials: "WP" },
  { name: null, kind: "hidden-team", state: "requested", required: true, initials: "?" },
  { name: "jo", kind: "person", state: "approved", required: false, initials: "JO" },
];

/** Two PR Lists: Mine cut short at its limit of one, Review requested whole. */
const PR_LISTS: PrListsView = {
  lists: [
    { name: "Mine", query: "is:open author:@me", search: "is:pr is:open author:@me repo:rbitco/lasso sort:updated-desc", url: "https://github.com/pulls?q=mine", limit: 1, total: 4, fetchedAt: ago(30), fetching: false, error: null, hidden: false, rows: [{ title: "Tick grace when the laptop sleeps", repo: "rbitco/lasso", number: 101, url: "https://github.com/rbitco/lasso/pull/101", author: "matt", updatedAt: ago(45 * 60), verdict: { word: "Checks failing", reason: "a required check failed", tone: "crit" }, checks: { passed: 7, failing: 2 }, reviewers: REVIEWERS, ticket: null, refs: [] }] },
    { name: "Review requested", query: "is:open review-requested:@me", search: "is:pr is:open review-requested:@me repo:rbitco/lasso sort:updated-desc", url: "https://github.com/pulls?q=review", limit: 25, total: 0, fetchedAt: ago(30), fetching: false, error: null, hidden: false, rows: [] },
  ],
  layout: "stacked",
  pausedUntil: null,
  ghProblem: null,
  example: null,
};

const VERSION: PipelineVersionView = { name: "default", version: 2, createdAt: ago(180), live: 1, deleted: false, pipeline: { profile: null, budget: {}, stages: [] } };

/** A Tick status as of now: last tick 10s ago, next in 20s. Built when sent, so a slow machine's delay since setup can't skew the tooltip. */
const freshTick = (): TickStatus => ({ tickSeconds: 30, lastTick: ago(10), nextTick: new Date(Date.now() + 20_000).toISOString(), running: false });

type Sent = { method: string; route: string; body: unknown };

/** A stand-in for Lasso's /api: Tickets, one Pipeline and its Version 2, config, the Tick, the version notice, and intake; every request it was sent. */
function fakeLasso() {
  const sent: Sent[] = [];
  const state = {
    tickets: [ticket("A"), ticket("B")],
    tick: freshTick(),
    changes: [] as TickResult["changes"],
    branchExisted: false,
    held: null as Promise<void> | null,
    // Holds intake's detect and add requests open, so their busy states can be seen.
    intakeHeld: null as Promise<void> | null,
    version: { version: "1.2.0", notice: { kind: "none" }, text: null } as VersionView,
    build: "1.2.3",
    prLists: PR_LISTS,
    prStatus: { failing: false } as PrListsStatus,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, route: url, body });
    if (url === "/api/tickets" || url === "/api/tickets?all=1") {
      if (method === "GET") return json(state.tickets);
      if (state.intakeHeld) await state.intakeHeld;
      return json({ ...ticket("N"), branch: "app-7-fix", branchExisted: state.branchExisted } satisfies IntakeResult);
    }
    const one = /^\/api\/tickets\/([^/]+)$/.exec(url);
    if (one) {
      if (state.held) await state.held;
      const t = state.tickets.find((x) => x.id === one[1]);
      return t ? json(t) : json({ error: `no Ticket matches ${one[1]}` }, 404);
    }
    if (url === "/api/health") return json({ ok: true, pid: 1, version: state.build, home: "/Users/me/.lasso", missingTools: [] } satisfies Health);
    if (url === "/api/tick") return json(state.tick);
    if (url === "/api/version") return json(state.version);
    if (url === "/api/check-now") return json({ at: ago(0), changes: state.changes } satisfies TickResult);
    if (url === "/api/intake/detect" && state.intakeHeld) await state.intakeHeld;
    if (url === "/api/intake/detect") return json(body.repo ? { ...DETECTED, notes: [`branch app-7 on ${body.repo}`] } : DETECTED);
    if (url === "/api/pipelines") return json([{ name: "default", file: "/p/default.yaml", profile: null, problem: null, stages: [] }] satisfies PipelineListing[]);
    if (url === "/api/pipelines/default/versions/2") return json(VERSION);
    if (url === "/api/config") return json({ file: "/c/config.yaml", text: "", config: DEFAULT_CONFIG, restart: [] } satisfies ConfigFile);
    if (url === "/api/actions") return json([]);
    if (url === "/api/pr-lists") return json(state.prLists);
    if (url === "/api/pr-lists/status") return json(state.prStatus);
    return json({ error: `not found: ${url}` }, 404);
  });
  return { sent, state, gets: (route: string) => sent.filter((s) => s.method === "GET" && s.route === route).length };
}

const send = (kind: string, data: unknown = {}) => act(() => void events().dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(data) })));
const dot = () => document.querySelector<HTMLElement>('[data-role="tick-dot"]')!;
const toggle = () => document.querySelector<HTMLElement>('[data-role="tick-toggle"]')!;
const popover = () => document.querySelector<HTMLElement>('[data-role="tick-pop"]');
const status = () => document.querySelector<HTMLElement>('[data-role="tick-status"]')!;
const notice = () => document.querySelector('[data-role="notice"]')!;
/** The value of the checked radio in the confirm step's group named `group`, or null. */
const chosen = (confirm: HTMLElement, group: string) => (within(within(confirm).getByRole("radiogroup", { name: group })).getAllByRole("radio") as HTMLInputElement[]).find((r) => r.checked)?.value ?? null;
const section = (role: string) => document.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
const shownViews = () => ["ledger", "detail", "prs", "pipelines", "config"].filter((r) => !section(r).hidden);
const navOn = () => [...document.querySelectorAll("nav .views a.on")].map((a) => a.textContent);
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

describe("the status dot", () => {
  it("is grey until Lasso answers, green when Ticks are on time, orange when one is overdue, and grey while unreachable", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    expect(dot().className).toBe("dot tick-dot connecting");
    expect(toggle().getAttribute("aria-label")).toBe("Lasso status: Connecting");
    send("hello", (lasso.state.tick = freshTick()));
    expect(dot().className).toBe("dot tick-dot healthy");
    expect(screen.getByRole("button", { name: "Lasso status: Healthy" })).toBe(toggle());
    send("tick", { ...lasso.state.tick, running: true });
    expect(dot().className).toBe("dot tick-dot running");
    // The next Tick was due two minutes ago.
    send("tick", { tickSeconds: 30, lastTick: ago(150), nextTick: ago(120), running: false });
    // The running Tick's pulse is held one cycle first.
    await waitFor(() => expect(dot().className).toBe("dot tick-dot late"), { timeout: 3000 });
    expect(toggle().getAttribute("aria-label")).toBe("Lasso status: Tick delayed");
    send("error");
    expect(dot().className).toBe("dot tick-dot down");
    expect(toggle().getAttribute("aria-label")).toBe("Lasso status: Not connected");
  });

  it("opens a popover with the status in words, the Tick's timing and Check now; Escape or a click away closes it", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    send("hello", (lasso.state.tick = freshTick()));
    expect(popover()).toBeNull();
    const user = userEvent.setup();
    await user.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(within(popover()!).getByText("Healthy")).toBeTruthy();
    expect(status().textContent).toBe("last tick 10s ago · next in 20s");
    expect(within(popover()!).getByRole("button", { name: "Check now" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(popover()).toBeNull();
    await user.click(toggle());
    send("tick", { tickSeconds: 30, lastTick: ago(150), nextTick: ago(120), running: false });
    expect(within(popover()!).getByText("Tick delayed")).toBeTruthy();
    expect(status().textContent).toBe("last tick 3m ago · next was due 2m ago; ticks run every 30s");
    send("error");
    expect(within(popover()!).getByText("Not connected")).toBeTruthy();
    expect((within(popover()!).getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByText("Ticket A"));
    expect(popover()).toBeNull();
  });

  it("holds a fast Tick's pulse for one cycle, though the popover follows at once", async () => {
    const lasso = fakeLasso();
    render(<App />);
    send("hello", (lasso.state.tick = freshTick()));
    await userEvent.setup().click(toggle());
    // The Tick ran and ended between two events: a newer lastTick than a still status.
    send("tick", { ...lasso.state.tick, lastTick: ago(0) });
    expect(dot().className).toBe("dot tick-dot running");
    expect(status().textContent).toMatch(/^last tick 0s ago/);
    await waitFor(() => expect(dot().className).toBe("dot tick-dot healthy"), { timeout: 3000 });
  });

  it("moves its countdown each second", async () => {
    const lasso = fakeLasso();
    render(<App />);
    send("hello", (lasso.state.tick = freshTick()));
    await userEvent.setup().click(toggle());
    expect(status().textContent).toBe("last tick 10s ago · next in 20s");
    await waitFor(() => expect(status().textContent).toBe("last tick 11s ago · next in 19s"), { timeout: 2000 });
  });

  it("reads everything again when Lasso comes back after being unreachable", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    send("hello", (lasso.state.tick = freshTick()));
    // One read for the Ledger, one for the nav's needs-you count.
    expect(lasso.gets("/api/tickets")).toBe(2);
    send("error");
    send("hello", (lasso.state.tick = freshTick()));
    expect(dot().className).toBe("dot tick-dot healthy");
    await waitFor(() => expect(lasso.gets("/api/tickets")).toBe(4));
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
    send("hello", (lasso.state.tick = freshTick()));
    await waitFor(() => expect(versionNotice()).toBeNull());
  });

  it("is absent when there is nothing to say", async () => {
    fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    expect(versionNotice()).toBeNull();
  });
});

describe("the dev badge", () => {
  beforeEach(() => {
    document.title = "Lasso";
  });

  it("marks a dev build in the header and the tab title", async () => {
    const lasso = fakeLasso();
    lasso.state.build = "0.0.0-dev";
    render(<App />);
    const badge = await screen.findByText("dev");
    expect(badge.closest("h1")).toBeTruthy();
    // The title is set in an effect, which may run after the badge first paints.
    await waitFor(() => expect(document.title).toBe("(dev) Lasso"));
  });

  it("is absent for a release", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    await waitFor(() => expect(lasso.gets("/api/health")).toBeGreaterThan(0));
    expect(document.querySelector('[data-role="dev-badge"]')).toBeNull();
    expect(document.title).toBe("Lasso");
  });
});

describe("Check now", () => {
  it("pulses the dot at once, runs a Tick, says what changed, and reads the page again", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    send("hello", (lasso.state.tick = freshTick()));
    lasso.state.changes = [
      { ticket: "A", summary: "APP-A: review started" },
      { ticket: "B", summary: "APP-B: PR merged" },
    ];
    const user = userEvent.setup();
    await user.click(toggle());
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(dot().className).toBe("dot tick-dot running");
    await waitFor(() => expect(notice().textContent).toBe("APP-A: review started; APP-B: PR merged"));
    expect(lasso.sent.filter((s) => s.method === "POST").map((s) => s.route)).toEqual(["/api/check-now"]);
    await waitFor(() => expect(lasso.gets("/api/tick")).toBe(1));
    // The Ledger's first read and the nav's needs-you count, then the Ledger again.
    await waitFor(() => expect(lasso.gets("/api/tickets")).toBe(3));
  });

  it("says nothing new when nothing changed", async () => {
    const lasso = fakeLasso();
    render(<App />);
    send("hello", (lasso.state.tick = freshTick()));
    const user = userEvent.setup();
    await user.click(toggle());
    await user.click(screen.getByRole("button", { name: "Check now" }));
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
    await user.click(screen.getByRole("button", { name: "Import" }));
    const confirm = section("confirm");
    await within(confirm).findByText("jira APP-7");
    expect(lasso.sent.filter((s) => s.route === "/api/intake/detect").at(-1)).toMatchObject({ method: "POST", body: { input: "APP-7" } });
    expect(within(confirm).getByText("Fix the login page")).toBeTruthy();
    expect(within(confirm).getByText("pick a repo to see the branch")).toBeTruthy();
    const repos = within(within(confirm).getByRole("radiogroup", { name: "Repo" })).getAllByRole("radio") as HTMLInputElement[];
    expect(repos.map((r) => r.value)).toEqual(["app", "web"]);
    expect(repos.filter((r) => r.checked)).toEqual([]);
    expect(chosen(confirm, "Pipeline")).toBe("default");

    expect(confirm.closest("dialog")!.open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Import Ticket" })).toBe(confirm.closest("dialog"));
    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    expect(within(confirm).getByText("repo is ambiguous: pick one")).toBeTruthy();

    await user.click(repos[1]!);
    expect(chosen(confirm, "Pipeline")).toBe("frontend");
    await within(confirm).findByText("branch app-7 on web");
    expect(lasso.sent.filter((s) => s.route === "/api/intake/detect").at(-1)).toMatchObject({ body: { input: "APP-7", repo: "web" } });

    const name = within(confirm).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.placeholder).toBe("optional; shown in place of APP-7");
    await user.type(name, " Login fix ");
    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(document.querySelector('[data-role="confirm"]')).toBeNull());
    expect(lasso.sent.find((s) => s.method === "POST" && s.route === "/api/tickets")!.body).toEqual({ input: "APP-7", repo: "web", pipeline: "frontend", name: "Login fix" });
    expect(notice().textContent).toBe("checked out existing branch app-7-fix");
    expect((screen.getByRole("textbox", { name: "Intake" }) as HTMLInputElement).value).toBe("");
    expect(location.hash).toBe("");
  });

  it("closes the confirm step on Cancel, and shows a refused detection", async () => {
    fakeLasso();
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Intake" }), "APP-7");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(document.querySelector('[data-role="confirm"]')).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "nothing to intake" }), { status: 400 }));
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(notice().textContent).toBe("nothing to intake"));
  });

  it("says when no repo can take the Ticket, links to Config, and holds Confirm", async () => {
    fakeLasso();
    const answer = fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url === "/api/intake/detect" ? new Response(JSON.stringify({ ...DETECTED, repo: { suggestion: null, choices: [] } })) : answer(url, init),
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Intake" }), "APP-7");
    await user.click(screen.getByRole("button", { name: "Import" }));
    const confirm = section("confirm");
    await within(confirm).findByText("No JIRA repo is set up yet.", { exact: false });
    expect(within(confirm).getByRole("link", { name: "Add one in Config" }).getAttribute("href")).toBe("#config");
    expect(within(confirm).getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
  });

  it("shows Add, the repo check and Confirm as busy, with their buttons disabled, until each answers", async () => {
    const lasso = fakeLasso();
    let release = () => {};
    const hold = () => (lasso.state.intakeHeld = new Promise<void>((r) => (release = r)));
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Intake" }), "APP-7");
    hold();
    await user.click(screen.getByRole("button", { name: "Import" }));
    const looking = await screen.findByRole("button", { name: "Looking up" });
    expect(looking).toHaveProperty("disabled", true);
    expect(looking.className).toContain("busy");
    await act(async () => release());

    const confirm = section("confirm");
    await within(confirm).findByText("jira APP-7");
    expect(screen.getByRole("button", { name: "Import" })).toHaveProperty("disabled", false);
    hold();
    await user.click(within(confirm).getByRole("radio", { name: "web" }));
    expect(within(confirm).getByText("checking web for an existing branch")).toBeTruthy();
    expect(within(confirm).getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
    await act(async () => release());
    await within(confirm).findByText("branch app-7 on web");

    hold();
    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    const adding = within(confirm).getByRole("button", { name: "Adding" });
    expect(adding).toHaveProperty("disabled", true);
    expect(adding.className).toContain("busy");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(within(confirm).getByRole("radio", { name: "web" }).matches(":disabled")).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(document.querySelector('[data-role="confirm"]')).toBeNull());
  });
});

describe("the page's views", () => {
  it("links Tickets, Pull Requests, Pipelines and Config, marking the one shown", async () => {
    fakeLasso();
    render(<App />);
    expect(within(document.querySelector("nav .views")!).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Tickets", "#"],
      ["Pull Requests", "#prs"],
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
    go("#prs");
    await screen.findByText("1 of 4");
    expect(navOn()).toEqual(["Pull Requests"]);
    expect(shownViews()).toEqual(["prs"]);
  });

  it("counts the Tickets that need you on Tickets, and keeps the count up as Tickets change", async () => {
    const lasso = fakeLasso();
    const needs = (t: TicketDetail): TicketDetail => ({ ...t, display: { state: "needs_you", label: "Needs you", why: "waiting on you" } });
    const flagged = (t: TicketDetail): TicketDetail => ({ ...t, display: { state: "flagged", label: "Flagged", why: "attempts exhausted" } });
    lasso.state.tickets = [needs(ticket("A")), ticket("B")];
    render(<App />);
    const tickets = () => within(section("nav")).getByRole("link", { name: /^Tickets/ });
    await waitFor(() => expect(tickets().textContent).toBe("Tickets1 need you"));
    lasso.state.tickets = [needs(ticket("A")), flagged(ticket("B"))];
    send("ticket", { ticket: "B" });
    await waitFor(() => expect(tickets().textContent).toBe("Tickets2 need you"));
    lasso.state.tickets = [ticket("A"), ticket("B")];
    send("ticket", { ticket: "A" });
    await waitFor(() => expect(section("needs-you")).toBeNull());
    expect(tickets().textContent).toBe("Tickets");
  });

  it("puts an amber dot on Pull Requests while a PR List is failing, on every page, without reading the lists", async () => {
    const lasso = fakeLasso();
    lasso.state.prStatus = { failing: true };
    render(<App />);
    const prs = () => within(section("nav")).getByRole("link", { name: /^Pull Requests/ });
    await waitFor(() => expect(prs().textContent).toBe("Pull Requests a PR List's last refresh failed"));
    // A refresh succeeds: its "prlists" event re-reads the status, and the dot clears.
    lasso.state.prStatus = { failing: false };
    send("prlists");
    await waitFor(() => expect(section("prs-failing")).toBeNull());
    // It fails again while Lasso was away: the reconnect's hello re-reads.
    lasso.state.prStatus = { failing: true };
    send("hello", freshTick());
    send("hello", freshTick());
    await waitFor(() => expect(section("prs-failing")).not.toBeNull());
    // Only the light status was read: reading the lists would count as the page being open.
    expect(lasso.gets("/api/pr-lists")).toBe(0);
  });

  it("shrinks the nav to an icon rail on a Ticket's page, its links and status dot still named", async () => {
    fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    expect(section("nav").className).toBe("pages");
    go("#A");
    await screen.findByRole("heading", { level: 2, name: "Ticket A" });
    expect(section("nav").className).toBe("pages compact");
    expect(section("shell").className).toBe("shell compact");
    expect(within(section("nav")).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("title")])).toEqual([
      ["LASSOL", null],
      ["Tickets", "Tickets"],
      ["Pull Requests", "Pull Requests"],
      ["Pipelines", "Pipelines"],
      ["Config", "Config"],
    ]);
    expect(within(section("nav")).getByRole("link", { name: "LASSO" }).getAttribute("href")).toBe("#");
    expect(within(section("nav")).getByRole("button", { name: "Lasso status: Connecting" }).getAttribute("title")).toBe("Lasso status: Connecting");
    go("");
    await waitFor(() => expect(section("nav").className).toBe("pages"));
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

  it("goes back to the Ledger from the LASSO heading", async () => {
    fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    go("#pipelines");
    await waitFor(() => expect(shownViews()).toEqual(["pipelines"]));
    await userEvent.setup().click(screen.getByRole("link", { name: "LASSO" }));
    await waitFor(() => expect(shownViews()).toEqual(["ledger"]));
    expect(location.hash).toBe("");
  });

  it("lists done and Abandoned Tickets when Show done and Abandoned is ticked", async () => {
    const lasso = fakeLasso();
    render(<App />);
    await screen.findByText("Ticket A");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show done and Abandoned" }));
    await waitFor(() => expect(lasso.gets("/api/tickets?all=1")).toBe(1));
  });
});

describe("the theme button", () => {
  // Node's own localStorage shadows jsdom's and is absent without a file, so these tests bring a store of their own.
  beforeEach(() => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, String(v)),
      removeItem: (k: string) => void kept.delete(k),
    });
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("follows the system at first, then steps through Light, Dark and back, keeping the choice in this browser", async () => {
    fakeLasso();
    render(<App />);
    const button = () => within(section("nav")).getByRole("button", { name: /^Theme/ });
    expect(button().textContent).toBe("Theme: System");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const user = userEvent.setup();
    await user.click(button());
    expect(button().textContent).toBe("Theme: Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("lasso.theme")).toBe("light");
    await user.click(button());
    expect(button().getAttribute("title")).toBe("Theme: Dark (click for System)");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(button());
    expect(button().textContent).toBe("Theme: System");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("lasso.theme")).toBeNull();
  });

  it("starts from the theme this browser kept", async () => {
    localStorage.setItem("lasso.theme", "dark");
    fakeLasso();
    render(<App />);
    expect(within(section("nav")).getByRole("button", { name: /^Theme/ }).textContent).toBe("Theme: Dark");
  });
});

describe("the Pull Requests page", () => {
  it("shows each PR List with N of total, links the rest on GitHub when cut short, and each PR's repo and number", async () => {
    fakeLasso();
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("1 of 4");
    const lists = [...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')];
    expect(lists.map((l) => l.getAttribute("aria-label"))).toEqual(["Mine", "Review requested"]);
    expect(within(lists[1]!).getByText("0 of 0")).toBeTruthy();
    expect(within(lists[1]!).queryByRole("link", { name: /^All/ })).toBeNull();
    const all = within(lists[0]!).getByRole("link", { name: /^All 4 on GitHub/ });
    expect([all.getAttribute("href"), all.getAttribute("target")]).toEqual(["https://github.com/pulls?q=mine", "_blank"]);
    const row = section("pr-row");
    expect(within(row).getByText("Tick grace when the laptop sleeps")).toBeTruthy();
    const pr = within(row).getByRole("link", { name: /^lasso #101/ });
    expect([pr.getAttribute("href"), pr.getAttribute("target")]).toEqual(["https://github.com/rbitco/lasso/pull/101", "_blank"]);
    expect(within(row).getByText(/^matt/).textContent).toBe("matt · 45m ago");
    // The verdict leads the row, its reason sits under the title, and the checks cell says what is failing.
    const pill = row.querySelector<HTMLElement>('[data-role="pr-verdict"]')!;
    expect([pill.textContent, pill.className, row.firstElementChild === pill]).toEqual(["Checks failing", "pr-verdict crit", true]);
    expect(within(row).getByText("a required check failed")).toBeTruthy();
    const checks = row.querySelector<HTMLElement>('[data-role="pr-checks"]')!;
    expect([checks.textContent, checks.title]).toEqual(["✗2 failing", "7 passed, 2 failing"]);
  });

  it("holds placeholder rows before a list's first fetch, shows its age and a spinner, and re-reads on each change and Tick", async () => {
    const lasso = fakeLasso();
    const [mine, review] = PR_LISTS.lists;
    lasso.state.prLists = { lists: [{ ...mine!, limit: 25, rows: [], total: 0, fetchedAt: null, fetching: true }, { ...review!, fetchedAt: ago(5 * 60) }], layout: "stacked", pausedUntil: null, ghProblem: null, example: null };
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("0 of 0", { selector: '[aria-label="Mine"] *' });
    const [first, second] = [...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')];
    // Three grey rows hold the first list's place, and its heading spins without an age.
    expect(first!.querySelectorAll('[data-role="pr-placeholders"] .placeholder')).toHaveLength(3);
    expect([first!.querySelector('[data-role="pr-age"] .spin') !== null, first!.querySelector('[data-role="pr-age"]')!.textContent]).toEqual([true, ""]);
    expect([second!.querySelector('[data-role="pr-age"]')!.textContent, second!.querySelector(".spin")]).toEqual(["updated 5m ago", null]);
    // The fetch finishes: a "prlists" event re-reads, and the rows and age take the placeholders' place.
    lasso.state.prLists = { lists: [{ ...mine!, fetchedAt: ago(10) }, { ...review!, fetchedAt: ago(5 * 60) }], layout: "stacked", pausedUntil: null, ghProblem: null, example: null };
    send("prlists");
    await screen.findByText("1 of 4");
    expect(document.querySelector('[data-role="pr-placeholders"]')).toBeNull();
    expect(section("pr-list").querySelector('[data-role="pr-age"]')!.textContent).toBe("updated just now");
    // Each Tick re-reads too, which is what keeps Lasso refreshing the lists while the page is open.
    const before = lasso.gets("/api/pr-lists");
    send("tick", freshTick());
    await waitFor(() => expect(lasso.gets("/api/pr-lists")).toBe(before + 1));
  });

  it("says a rate-limit pause in each heading, in local time, and keeps the rows", async () => {
    const lasso = fakeLasso();
    const until = new Date(2026, 9, 15, 15, 40).toISOString();
    lasso.state.prLists = { ...PR_LISTS, pausedUntil: until };
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("1 of 4");
    expect([...document.querySelectorAll('[data-role="pr-age"]')].map((a) => a.textContent)).toEqual(["paused until 3:40, GitHub rate limit", "paused until 3:40, GitHub rate limit"]);
    expect(document.querySelectorAll('[data-role="pr-row"]')).toHaveLength(1);
  });

  it("shows reviewer avatars with badges, rings and a hover list, and keeps their clicks from the row", async () => {
    fakeLasso();
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("1 of 4");
    const row = section("pr-row");
    const cell = row.querySelector<HTMLElement>('[data-role="pr-reviewers"]')!;
    const avatars = [...cell.querySelectorAll<HTMLElement>('[data-role="pr-reviewer"]')];
    // A picture when GitHub has one, else initials; teams are squares, hidden ones grey with "?"; required ones ringed.
    expect(avatars.map((a) => [a.className, a.querySelector("img")?.getAttribute("src") ?? a.firstChild?.textContent])).toEqual([
      ["rv-av person", "https://avatars.githubusercontent.com/u/1?v=4"],
      ["rv-av team req", "WP"],
      ["rv-av hidden-team req", "?"],
      ["rv-av person", "JO"],
    ]);
    expect(avatars.map((a) => a.querySelector(".rv-badge")!.className)).toEqual(["rv-badge crit", "rv-badge amber", "rv-badge amber", "rv-badge good"]);
    // The list opens on hover or focus, so the cell takes focus and names the list as its description.
    const pop = document.getElementById(cell.getAttribute("aria-describedby")!)!;
    expect([cell.tabIndex, pop.getAttribute("role")]).toEqual([0, "tooltip"]);
    expect([...pop.querySelectorAll(".rv-line")].map((l) => l.textContent)).toEqual([
      "±sam requested changes",
      "•@rbitco/web-platform review requestedrequired",
      "•a team you can't see on GitHub review requestedrequired",
      "✓jo approved",
    ]);
    expect(pop.querySelector(".rv-note")!.textContent).toBe("Required reviewers must approve before merging.");
    // React handles clicks at its root, so a click stopped in the cell never gets past it.
    const reached = vi.fn();
    document.addEventListener("click", reached);
    await userEvent.setup().click(avatars[0]!);
    document.removeEventListener("click", reached);
    expect(reached).not.toHaveBeenCalled();
  });

  it("shows a PR's Ticket and Stage and links the row to it, and links a row with no Ticket to GitHub", async () => {
    const lasso = fakeLasso();
    const [mine] = PR_LISTS.lists;
    const plain = mine!.rows[0]!;
    const linked = { ...plain, title: "Sleep-proof Tick", number: 102, url: "https://github.com/rbitco/lasso/pull/102", ticket: { id: "A", ref: "APP-A", stage: "review", flag: null } };
    lasso.state.prLists = { lists: [{ ...mine!, total: 2, rows: [linked, plain] }], layout: "stacked", pausedUntil: null, ghProblem: null, example: null };
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("2 of 2");
    const [withTicket, without] = [...document.querySelectorAll<HTMLElement>('[data-role="pr-row"]')];
    // The last column: the Ticket's ref over its Stage, or nothing.
    const cell = withTicket!.querySelector<HTMLElement>('[data-role="pr-ticket"]')!;
    expect([withTicket!.lastElementChild === cell, cell.querySelector("b")!.textContent, cell.querySelector(".sub")!.textContent]).toEqual([true, "APP-A", "review"]);
    expect(without!.querySelector<HTMLElement>('[data-role="pr-ticket"]')!.textContent).toBe("");
    // The row's link is its title: to the Ticket page in this tab, else to the PR on GitHub in a new tab.
    const open = (row: HTMLElement) => row.querySelector<HTMLAnchorElement>('[data-role="pr-open"]')!;
    expect([open(withTicket!).textContent, open(withTicket!).getAttribute("href"), open(withTicket!).getAttribute("target")]).toEqual(["Sleep-proof Tick", "#A", null]);
    expect([open(without!).getAttribute("href"), open(without!).getAttribute("target")]).toEqual(["https://github.com/rbitco/lasso/pull/101", "_blank"]);
    // "repo #n" always goes to GitHub, even on a row with a Ticket.
    const pr = within(withTicket!).getByRole("link", { name: /^lasso #102/ });
    expect([pr.getAttribute("href"), pr.getAttribute("target")]).toEqual(["https://github.com/rbitco/lasso/pull/102", "_blank"]);
    await userEvent.setup().click(open(withTicket!));
    expect(location.hash).toBe("#A");
  });

  it("follows a PR's Ticket with a ref: chip for each Ticket that references it, each linking to its Ticket", async () => {
    const lasso = fakeLasso();
    const [mine] = PR_LISTS.lists;
    const plain = mine!.rows[0]!;
    const refs = [{ id: "B", ref: "APP-B", stage: "implement", flag: null }, { id: "C", ref: "APP-C", stage: "done", flag: null }];
    const owned = { ...plain, number: 102, url: "https://github.com/rbitco/lasso/pull/102", ticket: { id: "A", ref: "APP-A", stage: "review", flag: null }, refs };
    const onlyRefs = { ...plain, refs: refs.slice(0, 1) };
    lasso.state.prLists = { lists: [{ ...mine!, total: 2, rows: [owned, onlyRefs] }], layout: "stacked", pausedUntil: null, ghProblem: null, example: null };
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await screen.findByText("2 of 2");
    const cells = [...document.querySelectorAll<HTMLElement>('[data-role="pr-ticket"]')];
    const chips = (cell: HTMLElement) => [...cell.querySelectorAll<HTMLAnchorElement>('[data-role="pr-ref"]')].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(cells[0]!.querySelector(".owner b")!.textContent).toBe("APP-A");
    expect(chips(cells[0]!)).toEqual([["ref: APP-B implement", "#B"], ["ref: APP-C done", "#C"]]);
    // Only references: no owner chip, and the row's title still opens the PR on GitHub.
    expect(cells[1]!.querySelector(".owner")).toBeNull();
    expect(chips(cells[1]!)).toEqual([["ref: APP-B implement", "#B"]]);
    expect(document.querySelectorAll<HTMLAnchorElement>('[data-role="pr-open"]')[1]!.getAttribute("target")).toBe("_blank");
    await userEvent.setup().click(cells[1]!.querySelector<HTMLAnchorElement>('[data-role="pr-ref"]')!);
    expect(location.hash).toBe("#B");
  });

  /** Renders the Pull Requests page over `view` and waits for its first read. */
  async function prsPage(view: PrListsView) {
    const lasso = fakeLasso();
    lasso.state.prLists = view;
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await waitFor(() => expect(lasso.gets("/api/pr-lists")).toBeGreaterThan(0));
    await waitFor(() => expect(section("prs").textContent).not.toContain("Reading PR Lists"));
    return lasso;
  }

  it("shows one notice in place of the lists while gh is not logged in, or not installed", async () => {
    await prsPage({ ...PR_LISTS, ghProblem: { kind: "not-logged-in", message: "gh is not logged in" } });
    const notice = section("pr-gh-problem");
    expect(notice.textContent).toBe("gh is not logged in, so Lasso cannot search GitHub.Run gh auth login, then Check now");
    expect(notice.querySelector("code")!.textContent).toBe("gh auth login");
    expect(document.querySelectorAll('[data-role="pr-list"]')).toHaveLength(0);
    cleanup();
    await prsPage({ ...PR_LISTS, ghProblem: { kind: "gh-missing", message: "gh is not installed" } });
    expect(section("pr-gh-problem").textContent).toBe("gh is not installed, so Lasso cannot search GitHub.Install gh from cli.github.com, then restart Lasso");
  });

  it("fails only the list whose query GitHub rejected, with GitHub's message, the search as sent and where to fix it", async () => {
    const [mine, review] = PR_LISTS.lists;
    await prsPage({ ...PR_LISTS, lists: [mine!, { ...review!, fetchedAt: null, error: { kind: "rejected", message: "The listed users cannot be searched" } }] });
    const [ok, bad] = [...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')];
    expect(ok!.querySelectorAll('[data-role="pr-row"]')).toHaveLength(1);
    expect(bad!.querySelector("h2 .name")!.textContent).toBe("Review requested");
    const error = bad!.querySelector<HTMLElement>('[data-role="pr-error"]')!;
    expect([error.className, error.querySelector("b")!.textContent, error.querySelector("pre")!.textContent, error.querySelector(".why")!.textContent]).toEqual([
      "card problem pr-problem",
      "GitHub rejected this query: The listed users cannot be searched",
      "is:pr is:open review-requested:@me repo:rbitco/lasso sort:updated-desc",
      "Fix it under pr_lists in config.yaml",
    ]);
    expect(bad!.querySelector('[data-role="pr-count"]')).toBeNull();
    expect(bad!.querySelector('[data-role="pr-empty"]')).toBeNull();
  });

  it("keeps the rows when a refresh fails after a good fetch, the age amber with why; before one, says why in their place", async () => {
    const [mine, review] = PR_LISTS.lists;
    await prsPage({ ...PR_LISTS, lists: [{ ...mine!, fetchedAt: ago(12 * 60), error: { kind: "failed", message: "timed out" } }, { ...review!, fetchedAt: null, error: { kind: "failed", message: "timed out" } }] });
    const [kept, never] = [...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')];
    const age = kept!.querySelector<HTMLElement>('[data-role="pr-age"]')!;
    expect([age.textContent, age.className]).toEqual(["updated 12m ago · last refresh failed: timed out", "age failed"]);
    expect(kept!.querySelectorAll('[data-role="pr-row"]')).toHaveLength(1);
    expect(kept!.querySelector('[data-role="pr-error"]')).toBeNull();
    expect(never!.querySelector('[data-role="pr-error"] b')!.textContent).toBe("Couldn't fetch this list: timed out");
    expect(never!.querySelector('[data-role="pr-placeholders"]')).toBeNull();
  });

  it("says a scoped list with no GitHub repos has nothing to search, and how to fix it", async () => {
    const [mine] = PR_LISTS.lists;
    await prsPage({ ...PR_LISTS, lists: [{ ...mine!, search: null, url: null, rows: [], total: 0, fetchedAt: null, error: { kind: "no-github-repos", message: "no repo in config.yaml has a github.com origin, so there is nothing to search. Add one under repos:, or name repo:, org: or user: in the query" } }] });
    const error = section("pr-error");
    expect([error.dataset.kind, error.textContent]).toEqual(["no-github-repos", "No repo in config.yaml has a github.com origin, so there is nothing to search. Add one under repos:, or name repo:, org: or user: in the query"]);
  });

  it("keeps an empty list's heading and says No PRs match, linking the search on GitHub", async () => {
    await prsPage(PR_LISTS);
    const empty = [...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')][1]!;
    expect(empty.querySelector("h2 .name")!.textContent).toBe("Review requested");
    const line = empty.querySelector<HTMLElement>('[data-role="pr-empty"]')!;
    const link = within(line).getByRole("link", { name: /^Search on GitHub/ });
    expect([line.textContent, link.getAttribute("href"), link.getAttribute("target")]).toEqual(["No PRs match · Search on GitHub ↗", "https://github.com/pulls?q=review", "_blank"]);
  });

  it("leaves hidden empty lists off the page, and names them in a note", async () => {
    const [mine, review] = PR_LISTS.lists;
    await prsPage({ ...PR_LISTS, lists: [mine!, { ...review!, hidden: true }, { ...review!, name: "Pending train", hidden: true }] });
    expect([...document.querySelectorAll<HTMLElement>('[data-role="pr-list"]')].map((l) => l.getAttribute("aria-label"))).toEqual(["Mine"]);
    expect(section("pr-hidden").textContent).toBe("2 empty lists hidden: Review requested, Pending train");
  });

  it("shows no hidden note when nothing is hidden", async () => {
    await prsPage(PR_LISTS);
    expect(document.querySelector('[data-role="pr-hidden"]')).toBeNull();
  });

  it("says there are no PR Lists with pr_lists: {}, with the defaults as an example, and keeps the nav entry", async () => {
    const example = "pr_lists:\n  Mine:\n    query: is:open author:@me\n    limit: 25\n";
    await prsPage({ lists: [], layout: "stacked", pausedUntil: null, ghProblem: null, example });
    const none = section("pr-none");
    expect([none.querySelector(".note")!.textContent, none.querySelector("pre")!.textContent]).toEqual(["No PR Lists. Add them under pr_lists in config.yaml", example]);
    expect(navOn()).toEqual(["Pull Requests"]);
  });
});

describe("the Pull Requests page's layout", () => {
  // As for the theme button: these tests bring a store of their own in place of Node's.
  let kept: Map<string, string>;
  beforeEach(() => {
    kept = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, String(v)),
      removeItem: (k: string) => void kept.delete(k),
    });
  });

  /** Renders the Pull Requests page over `view` and waits for its lists. */
  async function prsPage(view: PrListsView) {
    const lasso = fakeLasso();
    lasso.state.prLists = view;
    location.hash = "#prs";
    await new Promise((r) => setTimeout(r, 10));
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-role="pr-lists"]')).not.toBeNull());
    return lasso;
  }
  const shown = () => section("pr-lists").dataset.layout;
  const option = (name: string) => within(section("pr-layout")).getByRole("radio", { name });
  const checked = () => within(section("pr-layout")).getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")?.textContent;

  it("starts from pr_page_layout until this browser picks one", async () => {
    await prsPage(PR_LISTS);
    expect([shown(), checked()]).toEqual(["stacked", "Stacked"]);
    cleanup();
    await prsPage({ ...PR_LISTS, layout: "side-by-side" });
    expect([shown(), checked()]).toEqual(["side-by-side", "Side by side"]);
    expect(kept.size).toBe(0);
  });

  it("switches layouts, and keeps this browser's pick over config through a remount", async () => {
    await prsPage(PR_LISTS);
    const user = userEvent.setup();
    await user.click(option("Side by side"));
    expect([shown(), checked(), kept.get("lasso.prLayout")]).toEqual(["side-by-side", "Side by side", "side-by-side"]);
    cleanup();
    await prsPage(PR_LISTS);
    expect(shown()).toBe("side-by-side");
    await user.click(option("Stacked"));
    expect(kept.get("lasso.prLayout")).toBe("stacked");
    cleanup();
    await prsPage({ ...PR_LISTS, layout: "side-by-side" });
    expect(shown()).toBe("stacked");
  });

  it("still switches when this browser's storage can't be used", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    await prsPage({ ...PR_LISTS, layout: "side-by-side" });
    expect(shown()).toBe("side-by-side");
    await userEvent.setup().click(option("Stacked"));
    expect(shown()).toBe("stacked");
  });

  it("shows jump chips in Stacked with three or more lists, each naming its list and count and scrolling to it", async () => {
    const [mine, review] = PR_LISTS.lists;
    const drafts = { ...review!, name: "Drafts", fetchedAt: null, fetching: true };
    await prsPage({ ...PR_LISTS, lists: [mine!, review!, drafts] });
    const chips = () => document.querySelector<HTMLElement>('[data-role="pr-chips"]');
    const buttons = within(chips()!).getAllByRole("button");
    // A list not yet fetched has no count to give.
    expect(buttons.map((b) => b.textContent)).toEqual(["Mine1", "Review requested0", "Drafts"]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      await userEvent.setup().click(buttons[1]!);
      expect(scrolled.mock.contexts).toEqual([document.querySelectorAll('[data-role="pr-list"]')[1]]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    // Side by side shows every list at once, so it has no chips.
    await userEvent.setup().click(option("Side by side"));
    expect(chips()).toBeNull();
    // Two lists need none either.
    cleanup();
    kept.clear();
    await prsPage(PR_LISTS);
    expect(chips()).toBeNull();
    expect(section("pr-layout")).not.toBeNull();
  });
});

describe("the page's hash", () => {
  it("names the Ledger, a Ticket, Pull Requests, Pipelines with a Pipeline or one of its Versions, or Config", () => {
    expect(parseRoute("")).toEqual({ view: "ledger" });
    expect(parseRoute("#01J9ZX")).toEqual({ view: "detail", id: "01J9ZX", select: null });
    expect(parseRoute("#APP%2D7")).toEqual({ view: "detail", id: "APP-7", select: null });
    expect(parseRoute("#pipelines")).toEqual({ view: "pipelines", name: null, version: null });
    expect(parseRoute("#pipelines/my%20flow")).toEqual({ view: "pipelines", name: "my flow", version: null });
    expect(parseRoute("#pipelines/default/v12")).toEqual({ view: "pipelines", name: "default", version: 12 });
    expect(parseRoute("#config")).toEqual({ view: "config" });
    expect(parseRoute("#prs")).toEqual({ view: "prs" });
    // A malformed escape is taken as written.
    expect(parseRoute("#%E0")).toEqual({ view: "detail", id: "%E0", select: null });
  });

  it("points a Ticket's Session pane at a Session or a Stage, and writes those hashes back", () => {
    expect(parseRoute("#01J9ZX/sessions/S-1")).toEqual({ view: "detail", id: "01J9ZX", select: { session: "S-1" } });
    expect(parseRoute("#APP-7/stages/code%20review")).toEqual({ view: "detail", id: "APP-7", select: { stage: "code review" } });
    // Anything else after the Ticket is part of its key, as before.
    expect(parseRoute("#01J9ZX/other/x")).toEqual({ view: "detail", id: "01J9ZX/other/x", select: null });
    expect(ticketHref("01J9ZX")).toBe("#01J9ZX");
    expect(ticketHref("01J9ZX", { session: "S-1" })).toBe("#01J9ZX/sessions/S-1");
    expect(ticketHref("APP-7", { stage: "code review" })).toBe("#APP-7/stages/code%20review");
    for (const select of [null, { session: "S/1" }, { stage: "a/b c" }]) expect(parseRoute(ticketHref("APP-7", select))).toEqual({ view: "detail", id: "APP-7", select });
  });
});
