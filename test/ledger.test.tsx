// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { BudgetView } from "../src/budget/budget.ts";
import type { PrView, TicketView } from "../src/api/views.ts";
import { Ledger } from "../src/dashboard/app/ledger/Ledger.tsx";
import { Notice, showNotice } from "../src/dashboard/app/notice.tsx";
import { events } from "../src/dashboard/app/events.ts";

// The Ledger as a person uses it (ADR 0012): one row per Ticket in the API's order, its quick action, and how it
// keeps up with Lasso.

class FakeEventSource extends EventTarget {
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const BUDGET: BudgetView = {
  rounds: { used: 1, limit: 3, source: "global" },
  attempts: { used: 3, limit: 3, source: "global" },
  wallTime: { used: 90_000, limit: 1_800_000, source: "global", limitText: "30m" },
  spend: { used: 0.5, limit: 5, source: "pipeline" },
  ticket: { rounds: null, attempts: null, wallTime: null, spend: null },
};

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function view(id: string, over: Partial<TicketView> = {}): TicketView {
  return {
    id, shortId: id.slice(-8), title: `Ticket ${id}`, reference: `APP-${id}`, name: null, label: `APP-${id}`, origin: "tracker", body: null, repo: "app", branch: `app-${id}`, worktree: `/wt/${id}`, check: null,
    pipeline: "default", pipelineVersion: 1,
    stage: { name: "implement", kind: "runner", label: "implement", human: false, index: 1, total: 2, repeat: false, override: null },
    state: "active", flag: null, prs: [], display: { state: "quiet", label: "Quiet", why: "waiting on the next tick" }, queue: null, triggers: [], budget: BUDGET,
    stages: [
      { name: "plan", kind: "runner", label: "plan", human: false, skippedAt: null },
      { name: "implement", kind: "runner", label: "implement", human: false, skippedAt: null },
    ],
    mirrorPending: false, createdAt: ago(60), updatedAt: ago(5), url: `http://lasso/#${id}`, ...over,
  };
}

const flagged = () => view("A", { display: { state: "flagged", label: "Flagged", why: "attempts exhausted" }, triggers: [{ action: "retry", label: "Retry" }, { action: "abandon", label: "Abandon" }] });
const review = () => view("B", { prs: [{ url: "https://github.com/o/app/pull/2", number: 2, title: "Dark mode", role: "owned", source: "branch", state: "OPEN", head: "app-B", base: "main", author: "me", feedback: 0, checks: "green" }], stage: { name: "review", kind: "runner", label: "review", human: false, index: 1, total: 2, repeat: true, override: "codex" } });
const done = () => view("C", { state: "done", display: { state: "done", label: "Done", why: "merged" } });

type Sent = { method: string; route: string };

/** A stand-in for Lasso's /api: the Tickets it lists, in the order given, refusals by route, and every request. */
function fakeLasso(tickets: TicketView[]) {
  const sent: Sent[] = [];
  const state = { tickets, refuse: {} as Record<string, string> };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ method, route: url });
    if (state.refuse[url]) return json({ error: state.refuse[url] }, 409);
    if (url === "/api/tickets") return json(state.tickets.filter((t) => t.state === "active"));
    if (url === "/api/tickets?all=1") return json(state.tickets);
    return json({ changes: [] });
  });
  return { sent, state, reads: () => sent.filter((s) => s.method === "GET").length };
}

const rows = () => [...document.querySelectorAll<HTMLElement>("article.ticket")];
const row = (id: string) => document.querySelector<HTMLElement>(`article[data-id="${id}"]`)!;
const role = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`[data-role="${name}"]`)!;
const notice = () => document.querySelector('[data-role="notice"]')!;

beforeEach(() => {
  showNotice("");
  render(<Notice />);
  location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Ledger", () => {
  it("shows each Ticket in the API's order: pill, reference over repo, title over why, the track and Stage, rings, last activity, and the quick action", async () => {
    fakeLasso([flagged(), review()]);
    render(<Ledger all={false} visit={1} />);
    await screen.findByText("Ticket A");
    expect(rows().map((r) => r.dataset.id)).toEqual(["A", "B"]);
    const a = row("A");
    expect(role(a, "pill").textContent).toBe("Flagged");
    expect(role(a, "pill").className).toBe("pill flagged");
    expect(role(a, "ref").textContent).toBe("APP-A");
    expect(role(a, "ref").getAttribute("title")).toBe("APP-A");
    expect(role(a, "ref").nextElementSibling!.textContent).toBe("app");
    expect(role(a, "why").textContent).toBe("attempts exhausted");
    expect(within(a).getByLabelText("implement, Stage 2 of 2").tagName.toLowerCase()).toBe("svg");
    expect(role(a, "stage-text").textContent).toBe("implement · 2/2");
    // The profile is starred only where a human overrode the current Stage's.
    expect(role(row("B"), "stage-text").textContent).toBe("review · 2/2 · codex*");
    const rings = role(a, "rings");
    expect(rings.getAttribute("title")).toBe("Rounds 1/3 · attempts 3/3 · wall time 1m30s/30m · spend $0.50/$5");
    expect([...rings.querySelectorAll("svg")].map((s) => s.getAttribute("class"))).toEqual(["", "over", "", ""]);
    expect(role(a, "last").textContent).toBe("5s ago");
    // The attention trigger is the quick action, else Check PR now at a repeating Stage with a PR.
    expect(within(role(a, "quick")).getByRole("button").className).toBe("sm primary");
    expect(within(role(a, "quick")).getByRole("button").textContent).toBe("Retry");
    expect(within(role(row("B"), "quick")).getByRole("button", { name: "Check PR now" }).className).toBe("sm");
  });

  it("shows a named Ticket by its name, with the name and reference on hover", async () => {
    fakeLasso([view("A", { name: "Dark mode", label: "Dark mode" })]);
    render(<Ledger all={false} visit={1} />);
    await screen.findByText("Ticket A");
    const ref = role(row("A"), "ref");
    expect(ref.textContent).toBe("Dark mode");
    expect(ref.getAttribute("title")).toBe("Dark mode (APP-A)");
    expect(role(row("A"), "ref").nextElementSibling!.textContent).toBe("app");
  });

  it("lists done and Abandoned Tickets, greyed, only with all, and says so when there are none", async () => {
    const lasso = fakeLasso([flagged(), done()]);
    const view = render(<Ledger all={false} visit={1} />);
    await screen.findByText("Ticket A");
    expect(rows().map((r) => r.dataset.id)).toEqual(["A"]);
    view.rerender(<Ledger all={true} visit={1} />);
    await screen.findByText("Ticket C");
    expect(lasso.sent.at(-1)!.route).toBe("/api/tickets?all=1");
    expect(rows().map((r) => [r.dataset.id, r.className])).toEqual([
      ["A", "ticket"],
      ["C", "ticket ended"],
    ]);
    lasso.state.tickets = [];
    view.rerender(<Ledger all={true} visit={2} />);
    await screen.findByText("No Tickets yet. Paste a reference or a prompt above to start one.");
    view.rerender(<Ledger all={false} visit={2} />);
    await screen.findByText("No active Tickets. Paste a reference or a prompt above to start one.");
  });

  it("leads the why line with a chip per Owned PR, its dot toned by the PR's state, and leaves Referenced PRs off", async () => {
    const pr = (number: number, over: Partial<PrView> = {}): PrView => ({ url: `https://github.com/o/app/pull/${number}`, number, title: `PR ${number}`, role: "owned", source: "branch", state: "OPEN", head: `h${number}`, base: "main", author: "me", feedback: 0, checks: "green", ...over });
    fakeLasso([
      view("A", { prs: [pr(1), pr(2, { state: "MERGED" }), pr(3, { role: "referenced", source: "human" })] }),
      view("B", { prs: [pr(4, { state: "CLOSED" }), pr(5, { feedback: 2 }), pr(6, { checks: "failing" }), pr(7, { checks: "running" }), pr(8, { checks: "none" })] }),
      view("C"),
    ]);
    render(<Ledger all={false} visit={1} />);
    await screen.findByText("Ticket A");
    const chips = (id: string) => [...row(id).querySelectorAll<HTMLAnchorElement>('[data-role="pr-chip"]')];
    expect(chips("A").map((c) => [c.textContent, c.getAttribute("href"), c.getAttribute("title")])).toEqual([
      ["#1", "https://github.com/o/app/pull/1", "PR 1 · checks green"],
      ["#2", "https://github.com/o/app/pull/2", "PR 2 · merged"],
    ]);
    expect(role(row("A"), "why").textContent).toBe("#1#2waiting on the next tick");
    const dots = (id: string) => chips(id).map((c) => c.querySelector(".dot")!.className);
    expect(dots("A")).toEqual(["dot muted", "dot good"]);
    expect(dots("B")).toEqual(["dot crit", "dot crit", "dot crit", "dot run", "dot muted"]);
    // No Owned PR: the why text alone.
    expect(chips("C")).toEqual([]);
    expect(role(row("C"), "why").textContent).toBe("waiting on the next tick");
    // A chip opens the PR, not the Ticket.
    await userEvent.setup().click(chips("A")[0]!);
    expect(location.hash).toBe("");
  });

  it("opens a Ticket on a click of its row", async () => {
    fakeLasso([flagged()]);
    render(<Ledger all={false} visit={1} />);
    await userEvent.setup().click(await screen.findByText("Ticket A"));
    expect(location.hash).toBe("#A");
  });

  it("reads again once after a burst of ticket events, and moves last activity each second", async () => {
    const lasso = fakeLasso([flagged()]);
    render(<Ledger all={false} visit={1} />);
    await screen.findByText("Ticket A");
    expect(lasso.reads()).toBe(1);
    lasso.state.tickets = [view("A", { title: "Renamed" })];
    act(() => {
      for (let i = 0; i < 3; i++) events().dispatchEvent(new MessageEvent("ticket", { data: JSON.stringify({ ticket: "A" }) }));
    });
    await screen.findByText("Renamed");
    await new Promise((r) => setTimeout(r, 150));
    expect(lasso.reads()).toBe(2);
    expect(role(row("A"), "last").textContent).toBe("5s ago");
    await waitFor(() => expect(role(row("A"), "last").textContent).toBe("6s ago"), { timeout: 2000 });
  });
});

describe("a Ledger row's quick action", () => {
  it("pulls the trigger without opening the Ticket, then reads the Ledger again", async () => {
    const lasso = fakeLasso([flagged(), review()]);
    render(<Ledger all={false} visit={1} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Check PR now" }));
    await waitFor(() => expect(lasso.reads()).toBe(3));
    expect(lasso.sent.filter((s) => s.method === "POST").map((s) => s.route)).toEqual(["/api/tickets/A/retry", "/api/check-now"]);
    expect(location.hash).toBe("");
  });

  it("shows a refusal and can be pulled again", async () => {
    const lasso = fakeLasso([flagged()]);
    lasso.state.refuse["/api/tickets/A/retry"] = "attempts exhausted: extend first";
    render(<Ledger all={false} visit={1} />);
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry" });
    await user.click(retry);
    await waitFor(() => expect(notice().textContent).toBe("attempts exhausted: extend first"));
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(retry.className).toBe("sm primary");
  });
});
