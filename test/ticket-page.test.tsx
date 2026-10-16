// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_CONFIG, type Config } from "../src/server/config.ts";
import type { BudgetView } from "../src/budget/budget.ts";
import type { ConfigFile, PipelineListing, SessionView, StageProfileView, TicketDetail } from "../src/api/views.ts";
import { TicketPage } from "../src/dashboard/app/ticket/TicketPage.tsx";
import { closeProfileDrawer, ProfileDrawerHost } from "../src/dashboard/app/profiles/drawer.tsx";
import { events } from "../src/dashboard/app/events.ts";
import { usePlace } from "../src/dashboard/app/route.ts";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";

// A Ticket's page as a person uses it (ADR 0012): what it shows, what each lever sends, and how it keeps up with Lasso.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

// jsdom has <dialog> but not its modal methods; these stand in for what the stdout modal uses.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const T0 = "2026-10-12T10:00:00Z";

const BUDGET: BudgetView = {
  rounds: { used: 0, limit: 3, source: "global" },
  attempts: { used: 1, limit: 3, source: "global" },
  wallTime: { used: 60_000, limit: 1_800_000, source: "global", limitText: "30m" },
  spend: { used: 0.5, limit: 5, source: "ticket" },
  ticket: { rounds: null, attempts: null, wallTime: null, spend: 5 },
};

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: "S1", ticket: "A", stage: "plan", ordinal: 1, round: null, feedback: [], mode: "headless", startedBy: "auto", startedAt: T0, endedAt: T0, endedBy: null,
    endedReason: null, outcome: "succeeded", finalMessage: "Planned.", latestMessage: null, costUsd: 0.5, usage: null, limitsHonoured: [], openedAt: null, runnerSessionId: null,
    profile: { name: "claude-opus", runner: "claude", model: "opus", effort: null, permission: null, args: [] }, runner: "claude", stdoutPath: "/out/S1.log", transcriptPath: null,
    running: false, durationMs: 60_000, ...over,
  };
}

const profile = (stage: string, name: string, overridden = false): StageProfileView => ({
  stage, profile: name, from: overridden ? "override" : "default", overridden, headless: { runner: "claude", model: "opus" }, human: { runner: "claude", model: "opus" }, problem: null,
});

function ticket(id: string, over: Partial<TicketDetail> = {}): TicketDetail {
  const s = session({ ticket: id });
  return {
    id, shortId: id.slice(-8), title: `Ticket ${id}`, reference: `APP-${id}`, name: null, label: `APP-${id}`, origin: "tracker", body: null, repo: "app", branch: `app-${id}`, worktree: `/wt/${id}`, check: null,
    pipeline: "default", pipelineVersion: 2,
    stage: { name: "implement", kind: "runner", label: "implement", human: false, index: 1, total: 2, repeat: false, override: null },
    state: "active", flag: null, pr: null, display: { state: "quiet", label: "Quiet", why: "waiting on the next tick" }, queue: null,
    triggers: [
      { action: "done", label: "Mark done" },
      { action: "extend", label: "Extend" },
      { action: "abandon", label: "Abandon" },
    ],
    budget: BUDGET,
    stages: [
      { name: "plan", kind: "runner", label: "plan", human: false, skippedAt: null },
      { name: "implement", kind: "runner", label: "implement", human: false, skippedAt: null },
    ],
    mirrorPending: false, createdAt: T0, updatedAt: T0, url: `http://lasso/#${id}`,
    session: s, sessions: [session({ ticket: id, id: "S2", stage: "implement", outcome: "failed" }), s], pipelineDrift: "same",
    profiles: [profile("plan", "claude-opus"), profile("implement", "claude-opus")],
    ...over,
  };
}

const CONFIG: Config = { ...DEFAULT_CONFIG, profiles: { "claude-opus": { runner: "claude", model: "opus" }, codex: { runner: "codex", model: "gpt-6-sol" } }, default_profile: "claude-opus" };

type Sent = { method: string; route: string; body: unknown };

/**
 * A stand-in for Lasso's /api: the Tickets as they stand, each Session's output so far, replies held back to answer
 * late, replies a lever is refused with, and every write it was sent.
 */
function fakeLasso(tickets: TicketDetail[]) {
  const sent: Sent[] = [];
  const reads: string[] = [];
  const state = {
    tickets: Object.fromEntries(tickets.map((t) => [t.id, t])) as Record<string, TicketDetail>,
    stdout: {} as Record<string, string>,
    held: new Map<string, Promise<void>>(),
    refuse: {} as Record<string, { status: number; body: unknown }>,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const [route, query = ""] = url.split("?");
    reads.push(method + " " + url);
    if (route === "/api/config") return json({ file: "/c.yaml", text: "", config: CONFIG, restart: [] } satisfies ConfigFile);
    if (route === "/api/pipelines") return json([] satisfies PipelineListing[]);
    if (route === "/api/tickets") return json(Object.values(state.tickets).filter((t) => query === "all=1" || t.state === "active"));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== "GET") sent.push({ method, route: url, body });
    if (route === "/api/check-now") return json({ changes: [] });
    const m = /^\/api\/tickets\/([^/]+)(?:\/(.+))?$/.exec(route!);
    const t = m && state.tickets[decodeURIComponent(m[1]!)];
    if (!t) return json({ error: `no Ticket matches ${m?.[1]}` }, 404);
    const rest = m[2];
    if (!rest) {
      await state.held.get(t.id);
      return json(state.tickets[t.id]);
    }
    const out = /^sessions\/([^/]+)\/(stdout|stop)$/.exec(rest);
    if (out?.[2] === "stdout") {
      const text = state.stdout[out[1]!] ?? "";
      const from = Number(new URLSearchParams(query).get("offset"));
      return json({ text: text.slice(from), offset: text.length, ended: false });
    }
    if (out) return json(session());
    const refused = state.refuse[rest];
    if (refused) return json(refused.body, refused.status);
    if (rest === "name") state.tickets[t.id] = { ...t, name: body.name, label: body.name ?? t.reference ?? t.shortId };
    const stage = /^stages\/([^/]+)\/profile$/.exec(rest);
    if (stage) {
      const name = decodeURIComponent(stage[1]!);
      state.tickets[t.id] = { ...t, profiles: t.profiles.map((p) => (p.stage === name ? profile(name, method === "PUT" ? body.profile : "claude-opus", method === "PUT") : p)) };
    }
    return json(state.tickets[t.id]);
  });
  return { sent, reads, state };
}

let visit = 0;
let side: HTMLElement;
const page = (id: string, all = false) => <TicketPage id={id} select={null} visit={++visit} all={all} side={side} onShown={() => {}} />;

/** The page as the app shows it, following the hash, so a Stage or Session chosen on it moves the selection. */
function Routed() {
  const { place } = usePlace();
  const route = place.route;
  if (route.view !== "detail") return null;
  return <TicketPage id={route.id} select={route.select} visit={place.visit} all={false} side={side} onShown={() => {}} />;
}

async function showRouted(hash: string) {
  location.hash = hash;
  const view = render(<Routed />);
  await screen.findByRole("heading", { level: 2 });
  return view;
}
const title = () => screen.queryByRole("heading", { level: 2 })?.textContent ?? null;
const notice = () => document.querySelector('[data-role="notice"]')!;
const triggers = () => document.querySelector<HTMLElement>('[data-role="triggers"]')!;
const detailReads = (lasso: { reads: string[] }, id: string) => lasso.reads.filter((r) => r === `GET /api/tickets/${id}`).length;

async function showPage(id: string) {
  const view = render(page(id));
  await screen.findByRole("heading", { level: 2, name: `Ticket ${id}` });
  return view;
}

/** A promise held open until `release` is called. */
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
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
  side = document.createElement("aside");
  document.body.appendChild(side);
  location.hash = "";
});
afterEach(() => {
  closeProfileDrawer();
  cleanup();
  side.remove();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("a Ticket's page", () => {
  it("shows the title bar, the flow, the latest Session, the Pipeline Version, the gauges, the timeline and the sidebar", async () => {
    fakeLasso([ticket("A", { pr: "https://github.com/o/app/pull/7", pipelineDrift: "changed" }), ticket("B")]);
    await showPage("A");
    const bar = document.querySelector<HTMLElement>('[data-role="titlebar"]')!;
    expect(bar.querySelector(".eyebrow")!.textContent).toBe("APP-A · app · app-A · PR #7 · Name");
    expect(within(bar).getByRole("link", { name: "PR #7" }).getAttribute("href")).toBe("https://github.com/o/app/pull/7");
    expect(within(bar).getByText("Quiet").className).toBe("pill quiet");
    expect(within(triggers()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Mark done", "Extend", "Abandon"]);
    expect(screen.getByRole("img", { name: "Stage flow for APP-A" })).toBeTruthy();
    const pane = document.querySelector<HTMLElement>('[data-role="session"]')!;
    expect(within(pane).getByText("plan #1")).toBeTruthy();
    expect(within(pane).getByText("claude-opus (opus)")).toBeTruthy();
    expect(within(pane).getByText("Planned.")).toBeTruthy();
    const version = screen.getByRole("link", { name: "default v2" });
    expect(version.getAttribute("href")).toBe("#pipelines/default/v2");
    expect(version.parentElement!.textContent).toBe("default v2 · Pipeline has changed");
    // The spend limit is set on this Ticket, so it is starred.
    expect(document.querySelector('[data-gauge="spend"]')!.textContent).toBe("$0.50/$5*spend");
    expect(within(document.querySelector<HTMLElement>('[data-role="timeline"]')!).getAllByRole("listitem")).toHaveLength(2);
    // Only Stages not yet done offer a profile.
    expect([...document.querySelectorAll<HTMLElement>('[data-role="ticket-stage-profile"]')].map((b) => b.dataset.stage)).toEqual(["implement"]);
    expect(side.querySelector(".back")!.textContent).toBe("← all Tickets2 shown");
    expect([...side.querySelectorAll<HTMLElement>(".qitem")].map((q) => [q.dataset.id, q.classList.contains("sel")])).toEqual([["A", true], ["B", false]]);
    await userEvent.setup().click(within(side).getByText("Ticket B"));
    expect(location.hash).toBe("#B");
  });

  it("shows how the Stage's check Action last came out, and nothing when it has not run", async () => {
    const at = new Date(Date.now() - 120_000).toISOString();
    fakeLasso([ticket("A", { check: { action: "ci-green", result: "not_met", at, code: 1, line: "3 checks pending" } }), ticket("B")]);
    const a = await showPage("A");
    const check = document.querySelector<HTMLElement>('[data-role="check"]')!;
    expect(check.className).toBe("check not_met");
    expect(check.textContent).toBe("ci-green: not met · 2m ago3 checks pending");
    a.unmount();
    await showPage("B");
    expect(document.querySelector('[data-role="check"]')).toBeNull();
  });

  it("narrows the timeline to a station clicked in the flow, and widens it again with All Stages", async () => {
    fakeLasso([ticket("A")]);
    await showRouted("#A");
    const user = userEvent.setup();
    const timeline = () => document.querySelector<HTMLElement>('[data-role="timeline"]')!;
    await user.click(document.querySelector('[data-role="flow"] [data-stage="plan"]')!);
    await waitFor(() => expect(within(timeline()).getByRole("heading").textContent).toBe("Sessions · plan"));
    expect(location.hash).toBe("#A/stages/plan");
    expect(within(timeline()).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("plan #1")]);
    expect(document.querySelector('[data-stage="plan"]')!.getAttribute("class")).toContain("focus");
    await user.click(within(timeline()).getByRole("button", { name: "All Stages" }));
    await waitFor(() => expect(within(timeline()).getAllByRole("listitem")).toHaveLength(2));
    expect(location.hash).toBe("#A");
  });
});

describe("choosing the Session shown", () => {
  // implement #1 runs now; plan #1 and plan #2 are past.
  const live = session({ ticket: "A", id: "S3", stage: "implement", running: true, outcome: null, finalMessage: null, latestMessage: "Adding the toggle." });
  const plan2 = session({ ticket: "A", id: "S2", stage: "plan", ordinal: 2, finalMessage: "Planned again." });
  const plan1 = session({ ticket: "A", id: "S1", stage: "plan", ordinal: 1, outcome: "failed", finalMessage: "No plan." });
  const three = () => ticket("A", { session: live, sessions: [live, plan2, plan1] });
  const pane = () => document.querySelector<HTMLElement>('[data-role="session"]')!;
  const viewing = () => document.querySelector<HTMLElement>('[data-role="viewing"]');
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-role="timeline"] li')];

  it("shows a Stage's newest Session when its station is clicked, read-only under a banner, and goes back to the live one", async () => {
    fakeLasso([three()]);
    await showRouted("#A");
    expect(viewing()).toBeNull();
    expect(within(pane()).getByRole("button", { name: "Stop" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-role="flow"] [data-stage="plan"]')!);
    await waitFor(() => expect(within(pane()).getByText("plan #2")).toBeTruthy());
    expect(document.querySelector('[data-role="final"]')!.textContent).toBe("Planned again.");
    expect(viewing()!.textContent).toBe("Viewing plan #2 · the current Session, implement #1, is running" + "Back to current");
    expect(within(pane()).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(pane()).getByRole("button", { name: "View stdout" })).toBeTruthy();
    expect(rows().map((li) => li.className)).toEqual(["sel", ""]);

    await user.click(within(viewing()!).getByRole("button", { name: "Back to current" }));
    await waitFor(() => expect(viewing()).toBeNull());
    expect(location.hash).toBe("#A");
    expect(within(pane()).getByText("implement #1")).toBeTruthy();
    expect(within(pane()).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("shows a Session clicked in the timeline, marks its row, and keeps it in the hash", async () => {
    fakeLasso([three()]);
    await showRouted("#A");
    expect(rows().map((li) => li.getAttribute("aria-current"))).toEqual(["true", null, null]);
    await userEvent.setup().click(rows()[2]!);
    await waitFor(() => expect(within(pane()).getByText("plan #1")).toBeTruthy());
    expect(location.hash).toBe("#A/sessions/S1");
    expect(viewing()!.textContent).toContain("Viewing plan #1");
    // A Session's Stage narrows the timeline, with its row marked.
    expect(rows().map((li) => [li.dataset.session, li.className])).toEqual([["S2", ""], ["S1", "sel"]]);
  });

  it("opens on a linked Session or Stage, and on the live Session for one the Ticket lacks", async () => {
    fakeLasso([three()]);
    const view = await showRouted("#A/sessions/S1");
    expect(within(pane()).getByText("plan #1")).toBeTruthy();
    view.unmount();

    await showRouted("#A/sessions/nope");
    expect(within(pane()).getByText("implement #1")).toBeTruthy();
    expect(viewing()).toBeNull();
    cleanup();

    await showRouted("#A/stages/deploy");
    expect(within(pane()).getByText("implement #1")).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>('[data-role="timeline"]')!).getByRole("heading").textContent).toBe("Sessions");
  });

  it("says a Stage with no Sessions has none, in place of the pane, with the way back", async () => {
    const stages = [...three().stages, { name: "review", kind: "runner" as const, label: "review", human: false, skippedAt: null }];
    fakeLasso([ticket("A", { session: live, sessions: [live, plan2, plan1], stages })]);
    await showRouted("#A");
    await userEvent.setup().click(document.querySelector('[data-role="flow"] [data-stage="review"]')!);
    const empty = await waitFor(() => document.querySelector<HTMLElement>('[data-role="empty-stage"]')!);
    expect(empty.textContent).toBe("No Sessions for review yet · the current Session, implement #1, is running" + "Back to current");
    expect(document.querySelector('[data-role="session"]')).toBeNull();
    await userEvent.setup().click(within(empty).getByRole("button", { name: "Back to current" }));
    await waitFor(() => expect(within(pane()).getByText("implement #1")).toBeTruthy());
  });

  it("marks a skipped Stage on the diagram and says when it was skipped (LASSO-159)", async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const stages = [
      { name: "grill", kind: "runner" as const, label: "grill", human: true, skippedAt: at },
      { name: "plan", kind: "runner" as const, label: "plan", human: false, skippedAt: at },
      { name: "implement", kind: "runner" as const, label: "implement", human: false, skippedAt: null },
    ];
    fakeLasso([ticket("A", { session: live, sessions: [live, plan2, plan1], stages, stage: { ...three().stage, index: 2, total: 3 } })]);
    await showRouted("#A/stages/grill");
    const station = (name: string) => document.querySelector<SVGGElement>(`[data-role="flow"] [data-stage="${name}"]`)!;
    expect(station("grill").getAttribute("class")).toBe("node done skipped focus");
    expect(station("grill").textContent).toContain("skipped");
    expect(station("implement").getAttribute("class")).toBe("node current");
    const empty = await waitFor(() => document.querySelector<HTMLElement>('[data-role="empty-stage"]')!);
    expect(empty.textContent).toBe("Skipped grill 5m ago · the current Session, implement #1, is running" + "Back to current");
    // A Stage skipped after it ran (a Flagged one, say) still shows its Sessions, and says it was skipped.
    await showRouted("#A/stages/plan");
    await waitFor(() => expect(viewing()!.textContent).toBe("Viewing plan #2 · skipped 5m ago · the current Session, implement #1, is running" + "Back to current"));
  });

  it("stays on a past Session when a new one starts, naming it in a blue banner, until Back to current", async () => {
    const lasso = fakeLasso([three()]);
    await showRouted("#A/stages/plan");
    expect(within(pane()).getByText("plan #2")).toBeTruthy();
    const ended = { ...live, running: false, outcome: "failed" as const, finalMessage: "Tests fail." };
    const retry = session({ ticket: "A", id: "S4", stage: "implement", ordinal: 2, running: true, outcome: null, finalMessage: null });
    lasso.state.tickets.A = { ...lasso.state.tickets.A!, session: retry, sessions: [retry, ended, plan2, plan1] };
    act(() => void events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: "A" }) })));
    await waitFor(() => expect(viewing()!.className).toBe("viewing newer"));
    expect(viewing()!.textContent).toBe("Viewing plan #2 · implement #2 has started" + "Back to current");
    expect(within(pane()).getByText("plan #2")).toBeTruthy();

    await userEvent.setup().click(within(viewing()!).getByRole("button", { name: "Back to current" }));
    await waitFor(() => expect(within(pane()).getByText("implement #2")).toBeTruthy());
    expect(viewing()).toBeNull();
  });

  it("names no running Session in the banner when the live one has ended", async () => {
    const ended = { ...live, running: false, outcome: "succeeded" as const, finalMessage: "Done." };
    fakeLasso([ticket("A", { session: ended, sessions: [ended, plan2, plan1] })]);
    await showRouted("#A/stages/plan");
    expect(viewing()!.textContent).toBe("Viewing plan #2" + "Back to current");
  });
});

describe("naming a Ticket", () => {
  it("names it from the title bar, keeps the reference beside the name, and clears it with an empty name", async () => {
    const lasso = fakeLasso([ticket("A")]);
    await showPage("A");
    const user = userEvent.setup();
    const bar = () => document.querySelector<HTMLElement>('[data-role="titlebar"]')!;
    await user.click(within(bar()).getByRole("button", { name: "Name" }));
    await user.type(within(bar()).getByRole("textbox", { name: "Ticket name" }), "Dark mode{Enter}");
    await waitFor(() => expect(bar().querySelector('[data-role="name"]')?.textContent).toBe("Dark mode"));
    expect(bar().querySelector(".eyebrow")!.textContent).toBe("Dark mode · APP-A · app · app-A · Rename");
    expect(document.querySelector(`[data-id="A"] .ref`)!.textContent).toMatch(/^Dark mode · /);

    await user.click(within(bar()).getByRole("button", { name: "Rename" }));
    const input = within(bar()).getByRole("textbox", { name: "Ticket name" });
    expect(input).toHaveProperty("value", "Dark mode");
    await user.keyboard("{Escape}");
    expect(within(bar()).queryByRole("textbox")).toBeNull();
    await user.click(within(bar()).getByRole("button", { name: "Rename" }));
    await user.clear(within(bar()).getByRole("textbox", { name: "Ticket name" }));
    await user.click(within(bar()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bar().querySelector('[data-role="name"]')).toBeNull());
    expect(lasso.sent).toEqual([
      { method: "PUT", route: "/api/tickets/A/name", body: { name: "Dark mode" } },
      { method: "PUT", route: "/api/tickets/A/name", body: { name: null } },
    ]);
  });
});

describe("switching Tickets", () => {
  it("never draws a slow answer for an earlier Ticket over a later one", async () => {
    const lasso = fakeLasso([ticket("A"), ticket("B")]);
    const slow = held();
    lasso.state.held.set("A", slow.promise);
    const view = render(page("A"));
    view.rerender(page("B"));
    await screen.findByRole("heading", { level: 2, name: "Ticket B" });
    await act(async () => slow.release());
    await new Promise((r) => setTimeout(r, 20));
    expect(title()).toBe("Ticket B");
    expect(side.querySelector(".sel")!.getAttribute("data-id")).toBe("B");
  });

  it("keeps the Ticket shown until the next one arrives, then changes the page and sidebar at once", async () => {
    const lasso = fakeLasso([ticket("A"), ticket("B")]);
    const view = await showPage("A");
    const slow = held();
    lasso.state.held.set("B", slow.promise);
    view.rerender(page("B"));
    expect(title()).toBe("Ticket A");
    await act(async () => slow.release());
    await screen.findByRole("heading", { level: 2, name: "Ticket B" });
    expect(side.querySelector(".sel")!.getAttribute("data-id")).toBe("B");
  });

  it("goes back to the Ledger, saying why, when the Ticket is not found", async () => {
    fakeLasso([]);
    location.hash = "#gone";
    render(page("gone"));
    await waitFor(() => expect(notice().textContent).toBe("no Ticket matches gone"));
    expect(location.hash).toBe("");
  });
});

describe("keeping up with Lasso", () => {
  it("re-reads the Ticket when the server says it changed, and only the sidebar for another Ticket", async () => {
    const lasso = fakeLasso([ticket("A"), ticket("B")]);
    await showPage("A");
    const ticketEvent = (id: string) => act(() => void events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: id }) })));
    lasso.state.tickets.B = { ...lasso.state.tickets.B!, title: "Ticket B renamed" };
    ticketEvent("B");
    await within(side).findByText("Ticket B renamed");
    expect(detailReads(lasso, "A")).toBe(1);
    lasso.state.tickets.A = { ...lasso.state.tickets.A!, title: "Ticket A renamed" };
    ticketEvent("A");
    ticketEvent("A");
    await screen.findByRole("heading", { level: 2, name: "Ticket A renamed" });
    // A burst is read once.
    expect(detailReads(lasso, "A")).toBe(2);
  });

  it("keeps stdout out of the pane, behind a button that opens it in a modal", async () => {
    const lasso = fakeLasso([ticket("A")]);
    lasso.state.stdout.S1 = "planning\n";
    await showPage("A");
    const pane = document.querySelector<HTMLElement>('[data-role="session"]')!;
    expect(pane.querySelector("pre")).toBeNull();
    expect(within(pane).queryByRole("button", { name: "stdout" })).toBeNull();
    expect(lasso.reads.filter((r) => r.includes("/stdout"))).toEqual([]);
    const user = userEvent.setup();
    await user.click(within(pane).getByRole("button", { name: "View stdout" }));
    const modal = document.querySelector<HTMLDialogElement>('[data-role="stdout"]')!;
    expect(modal.open).toBe(true);
    expect(within(modal).getByText("plan #1 · stdout")).toBeTruthy();
    expect(within(modal).getByText("/out/S1.log")).toBeTruthy();
    await waitFor(() => expect(modal.querySelector("pre")!.textContent).toBe("planning\n"));
    await user.click(within(modal).getByRole("button", { name: "Close" }));
    expect(document.querySelector('[data-role="stdout"]')).toBeNull();
    // Escape closes it too.
    await user.click(within(pane).getByRole("button", { name: "View stdout" }));
    act(() => void document.querySelector('[data-role="stdout"]')!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(document.querySelector('[data-role="stdout"]')).toBeNull();
  });

  it("shows a running Session's Latest Message, live, with a placeholder before the first", async () => {
    const running = session({ ticket: "A", id: "S9", stage: "implement", running: true, outcome: null, finalMessage: null });
    const lasso = fakeLasso([ticket("A", { session: running, sessions: [running] })]);
    await showPage("A");
    const words = document.querySelector<HTMLElement>('[data-role="words"]')!;
    expect(words.textContent).toBe("Latest Message" + "Waiting for the agent's first message…");
    expect(words.querySelector(".live-dot")).toBeTruthy();
    const said = { ...running, latestMessage: "Adding the toggle." };
    lasso.state.tickets.A = { ...lasso.state.tickets.A!, session: said, sessions: [said] };
    act(() => void events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: "A" }) })));
    await waitFor(() => expect(document.querySelector('[data-role="latest"]')!.textContent).toBe("Adding the toggle."));
  });

  it("shows an ended Session's final message, with the agent's last words only when they differ", async () => {
    const same = session({ finalMessage: "Planned.", latestMessage: "Planned." });
    fakeLasso([ticket("A", { session: same, sessions: [same] })]);
    await showPage("A");
    expect(document.querySelector('[data-role="final"]')!.textContent).toBe("Planned.");
    expect(document.querySelector('[data-role="final"]')!.className).toBe("words-text ok");
    expect(document.querySelector('[data-role="last-words"]')).toBeNull();
    cleanup();

    const killed = session({ outcome: "interrupted", finalMessage: "killed: stop", latestMessage: "Adding the toggle." });
    fakeLasso([ticket("A", { session: killed, sessions: [killed] })]);
    await showPage("A");
    expect(document.querySelector('[data-role="final"]')!.className).toBe("words-text");
    expect(document.querySelector('[data-role="words"]')!.textContent).toBe("Final message" + "killed: stop" + "Agent's last words" + "Adding the toggle.");
  });

  it("shows a running config Action's last line, waiting on its first line of output before that", async () => {
    const action = session({ ticket: "A", id: "S4", stage: "notify", mode: "action", runner: null, profile: null, running: true, outcome: null, finalMessage: null });
    const lasso = fakeLasso([ticket("A", { session: action, sessions: [action] })]);
    await showPage("A");
    expect(document.querySelector('[data-role="latest"]')!.textContent).toBe("Waiting for the first line of output…");
    const said = { ...action, latestMessage: "deploying to staging" };
    lasso.state.tickets.A = { ...lasso.state.tickets.A!, session: said, sessions: [said] };
    act(() => void events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: "A" }) })));
    await waitFor(() => expect(document.querySelector('[data-role="latest"]')!.textContent).toBe("deploying to staging"));
  });

  it("offers no stdout for a built-in action Session", async () => {
    const action = session({ ticket: "A", id: "S3", stage: "transition-done", mode: "action", stdoutPath: null, runner: null, profile: null, finalMessage: "moved to Done" });
    fakeLasso([ticket("A", { session: action, sessions: [action] })]);
    await showPage("A");
    const pane = document.querySelector<HTMLElement>('[data-role="session"]')!;
    expect(within(pane).getByText("Lasso performed this Stage itself; there is no Runner output.")).toBeTruthy();
    expect(within(pane).queryByRole("button", { name: /View stdout/ })).toBeNull();
  });

  it("tails a running Session's stdout in the modal from where it stopped, on each stdout event for it, and Stops it", async () => {
    const running = session({ ticket: "A", id: "S9", stage: "implement", running: true, outcome: null, finalMessage: null });
    const lasso = fakeLasso([ticket("A", { session: running, sessions: [running] })]);
    lasso.state.stdout.S9 = "reading the code\n";
    await showPage("A");
    await userEvent.setup().click(screen.getByRole("button", { name: "View stdout (live)" }));
    const out = document.querySelector('[data-role="stdout"] pre')!;
    await waitFor(() => expect(out.textContent).toBe("reading the code\n"));
    const stdoutEvent = (id: string) => act(() => void events().dispatchEvent(new MessageEvent("stdout", { data: JSON.stringify({ ticket: "A", session: id }) })));
    lasso.state.stdout.S9 += "writing a test\n";
    stdoutEvent("S9");
    await waitFor(() => expect(out.textContent).toBe("reading the code\nwriting a test\n"));
    expect(lasso.reads.filter((r) => r.includes("/stdout"))).toEqual(["GET /api/tickets/A/sessions/S9/stdout?offset=0", "GET /api/tickets/A/sessions/S9/stdout?offset=17"]);
    stdoutEvent("other");
    await new Promise((r) => setTimeout(r, 20));
    expect(lasso.reads.filter((r) => r.includes("/stdout"))).toHaveLength(2);

    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    expect(lasso.sent).toEqual([{ method: "POST", route: "/api/tickets/A/sessions/S9/stop", body: null }]);
    // The Session ending reads the last of its output, and keeps what was shown.
    const ended = { ...running, running: false, outcome: "interrupted" as const, endedReason: "stop" as const };
    lasso.state.tickets.A = { ...lasso.state.tickets.A!, session: ended, sessions: [ended] };
    lasso.state.stdout.S9 += "stopped\n";
    act(() => void events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: "A" }) })));
    await waitFor(() => expect(out.textContent).toBe("reading the code\nwriting a test\nstopped\n"));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("the Ticket's exits", () => {
  it("asks for a second press before Abandon, and forgets it after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const lasso = fakeLasso([ticket("A")]);
      await showPage("A");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(within(triggers()).getByRole("button", { name: "Abandon" }));
      expect(lasso.sent).toEqual([]);
      expect(within(triggers()).getByRole("button", { name: "Abandon for sure?" })).toBeTruthy();
      act(() => void vi.advanceTimersByTime(4000));
      await user.click(within(triggers()).getByRole("button", { name: "Abandon" }));
      expect(lasso.sent).toEqual([]);
      await user.click(within(triggers()).getByRole("button", { name: "Abandon for sure?" }));
      await waitFor(() => expect(lasso.sent).toEqual([{ method: "POST", route: "/api/tickets/A/abandon", body: {} }]));
      await waitFor(() => expect(detailReads(lasso, "A")).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Advance anyway when Mark done finds the artifact missing, and sends it with override", async () => {
    const lasso = fakeLasso([ticket("A")]);
    lasso.state.refuse.done = { status: 409, body: { error: "artifact missing", artifact: "file NOTES.md", detail: "no NOTES.md on the branch", override: true } };
    await showPage("A");
    const user = userEvent.setup();
    await user.click(within(triggers()).getByRole("button", { name: "Mark done" }));
    const override = await screen.findByText("artifact file NOTES.md is missing: no NOTES.md on the branch");
    expect(notice().textContent).toBe("");
    delete lasso.state.refuse.done;
    await user.click(within(override.parentElement!).getByRole("button", { name: "Advance anyway" }));
    await waitFor(() => expect(document.querySelector('[data-role="override"]')).toBeNull());
    expect(lasso.sent).toEqual([
      { method: "POST", route: "/api/tickets/A/done", body: {} },
      { method: "POST", route: "/api/tickets/A/done", body: { override: true } },
    ]);
  });

  it("puts a Flagged Ticket's exits in its Flag box, says why one is unavailable, and shows a refusal", async () => {
    const lasso = fakeLasso([
      ticket("A", {
        flag: { at: T0, reason: "Session failed", detail: "exit code 1" },
        display: { state: "flagged", label: "Flagged", why: "Session failed" },
        triggers: [
          { action: "retry", label: "Retry" },
          { action: "resume", label: "Resume", unavailable: "the profile runs on codex" },
          { action: "abandon", label: "Abandon" },
        ],
      }),
    ]);
    lasso.state.refuse.retry = { status: 400, body: { error: "no headless slot free" } };
    await showPage("A");
    const box = document.querySelector<HTMLElement>('[data-role="flagbox"]')!;
    expect(within(box).getByText("Session failed")).toBeTruthy();
    expect(within(box).getByText("exit code 1")).toBeTruthy();
    expect(document.querySelector('[data-role="titlebar"] [data-role="triggers"]')).toBeNull();
    const resume = within(box).getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(within(box).getByText("Resume is unavailable: the profile runs on codex")).toBeTruthy();
    await userEvent.setup().click(within(box).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(notice().textContent).toBe("no headless slot free"));
    expect((within(box).getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
    expect(lasso.sent).toEqual([{ method: "POST", route: "/api/tickets/A/retry", body: {} }]);
  });

  it("shows Check PR now at a repeating Stage with a PR, which runs a tick", async () => {
    const lasso = fakeLasso([ticket("A", { pr: "https://github.com/o/app/pull/7", stage: { ...ticket("A").stage, repeat: true } })]);
    await showPage("A");
    await userEvent.setup().click(within(triggers()).getByRole("button", { name: "Check PR now" }));
    await waitFor(() => expect(lasso.sent).toEqual([{ method: "POST", route: "/api/check-now", body: null }]));
  });
});

describe("the Budget gauges on a human Stage", () => {
  it("grey out wall time and spend as not tracked, keeping what earlier Sessions spent", async () => {
    const untracked = (spend: number): BudgetView => ({ ...BUDGET, wallTime: { ...BUDGET.wallTime, untracked: true }, spend: { ...BUDGET.spend, used: spend, untracked: true } });
    fakeLasso([ticket("A", { budget: untracked(0) }), ticket("B", { budget: untracked(1.25) })]);
    await showPage("A");
    const gauge = (k: string) => document.querySelector<HTMLElement>(`[data-gauge="${k}"]`)!;
    expect(gauge("wallTime").textContent).toBe("not trackedwall time");
    expect(gauge("spend").textContent).toBe("not tracked*spend");
    expect(gauge("spend").className).toBe("gauge untracked");
    expect(gauge("spend").title).toMatch(/^not tracked in a terminal Session/);
    expect(gauge("attempts").className).toBe("gauge");
    await showPage("B");
    expect([...document.querySelectorAll('[data-gauge="spend"]')].at(-1)!.textContent).toBe("$1.25 so far*spend");
  });
});

describe("the Budget editor", () => {
  it("opens from a gauge with the Ticket's own limits, refuses a non-number, and sends Extend with every field", async () => {
    const lasso = fakeLasso([ticket("A")]);
    await showPage("A");
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-gauge="rounds"]')!);
    const editor = document.querySelector<HTMLElement>('[data-role="budget-editor"]')!;
    const field = (label: string) => within(editor).getByLabelText(label) as HTMLInputElement;
    expect(document.activeElement).toBe(field("Rounds"));
    expect([field("Rounds").value, field("Rounds").placeholder]).toEqual(["", "3"]);
    expect([field("wall time (30m, 1h)").value, field("wall time (30m, 1h)").placeholder]).toEqual(["", "30m"]);
    expect(field("spend (USD)").value).toBe("5");
    await user.type(field("Rounds"), "5");
    await user.type(field("attempts"), "lots");
    await user.type(field("wall time (30m, 1h)"), "1h");
    await user.clear(field("spend (USD)"));
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(notice().textContent).toBe("attempts must be a number");
    expect(document.activeElement).toBe(field("attempts"));
    expect(lasso.sent).toEqual([]);
    await user.clear(field("attempts"));
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.querySelector('[data-role="budget-editor"]')).toBeNull());
    expect(lasso.sent).toEqual([{ method: "POST", route: "/api/tickets/A/extend", body: { rounds: 5, attempts: null, wallTime: "1h", spend: null } }]);
  });

  it("opens from Extend and closes on Cancel without sending anything", async () => {
    const lasso = fakeLasso([ticket("A")]);
    await showPage("A");
    const user = userEvent.setup();
    await user.click(within(triggers()).getByRole("button", { name: "Extend" }));
    await user.click(within(document.querySelector<HTMLElement>('[data-role="budget-editor"]')!).getByRole("button", { name: "Cancel" }));
    expect(document.querySelector('[data-role="budget-editor"]')).toBeNull();
    expect(lasso.sent).toEqual([]);
  });
});

describe("a Stage's profile on the Ticket", () => {
  it("opens the drawer on the Ticket's repo, where Use sets this Ticket's override and Clear override removes it", async () => {
    const lasso = fakeLasso([ticket("A")]);
    await showPage("A");
    const user = userEvent.setup();
    const button = () => document.querySelector<HTMLElement>('[data-role="ticket-stage-profile"][data-stage="implement"]')!;
    expect([...button().children].map((c) => c.textContent)).toEqual(["implement", "claude-opus", "claude · opus · auto · human: edits"]);
    await user.click(button());
    let drawer = await screen.findByRole("dialog", { name: "Agent Profiles" });
    expect(await within(drawer).findByText("Stage implement of Ticket APP-A")).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Clear override" })).toBeNull();
    await user.click(await within(drawer.querySelector<HTMLElement>('[data-role="profile-nav"]')!).findByText("codex"));
    await user.click(await within(drawer).findByRole("button", { name: "Use codex for this Ticket's implement" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lasso.sent).toEqual([{ method: "PUT", route: "/api/tickets/A/stages/implement/profile", body: { profile: "codex" } }]);
    await waitFor(() => expect(within(button()).getByText("overridden")).toBeTruthy());
    expect(within(button()).getByText(/^codex/)).toBeTruthy();

    await user.click(button());
    drawer = await screen.findByRole("dialog", { name: "Agent Profiles" });
    await user.click(await within(drawer).findByRole("button", { name: "Clear override" }));
    await waitFor(() => expect(within(button()).queryByText("overridden")).toBeNull());
    expect(lasso.sent[1]).toEqual({ method: "DELETE", route: "/api/tickets/A/stages/implement/profile", body: null });
  });

  it("retries a Flagged Stage under a profile picked in the drawer", async () => {
    const lasso = fakeLasso([
      ticket("A", { flag: { at: T0, reason: "Session failed", detail: null }, triggers: [{ action: "retry", label: "Retry" }, { action: "abandon", label: "Abandon" }] }),
    ]);
    await showPage("A");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "retry with…" }));
    const drawer = await screen.findByRole("dialog", { name: "Agent Profiles" });
    expect(await within(drawer).findByText(/^Retry Stage implement of Ticket APP-A under another profile/)).toBeTruthy();
    await user.click(await within(drawer.querySelector<HTMLElement>('[data-role="profile-nav"]')!).findByText("codex"));
    await user.click(await within(drawer).findByRole("button", { name: "Retry implement with codex" }));
    await waitFor(() => expect(lasso.sent).toEqual([{ method: "POST", route: "/api/tickets/A/retry", body: { profile: "codex" } }]));
    await waitFor(() => expect(detailReads(lasso, "A")).toBe(2));
  });
});
