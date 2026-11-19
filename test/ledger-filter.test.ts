import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LEDGER_ORDER, type DisplayState, type TicketView } from "../src/api/views.ts";
import { countActive, DEFAULT_HIDDEN, endedShown, filterLabel, FILTER_KEY, loadHidden, notShowing, saveHidden, shownTickets, STATES } from "../src/dashboard/app/ledger/filter.ts";

const set = (...states: DisplayState[]) => new Set<DisplayState>(states);
const ticket = (id: string, state: DisplayState) => ({ id, display: { state, label: state, why: "" } }) as TicketView;

describe("the Ledger's state filter", () => {
  let kept: Map<string, string>;
  beforeEach(() => {
    // Node's own localStorage shadows jsdom's and is absent without a file, so these tests bring a store of their own.
    kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, String(v)) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists every state the server serves, in the Ledger's order", () => {
    expect(STATES).toEqual(LEDGER_ORDER);
  });

  it("hides Done and Abandoned until told otherwise", () => {
    expect([...loadHidden()]).toEqual(["done", "abandoned"]);
  });

  it("keeps the hidden states, and falls back to the default on anything it cannot read", () => {
    saveHidden(set("quiet", "done"));
    expect(kept.get(FILTER_KEY)).toBe('["quiet","done"]');
    expect([...loadHidden()]).toEqual(["quiet", "done"]);
    saveHidden(set());
    expect([...loadHidden()]).toEqual([]);
    for (const bad of ["{", '"quiet"', "null", '{"quiet":true}']) {
      kept.set(FILTER_KEY, bad);
      expect(loadHidden()).toBe(DEFAULT_HIDDEN);
    }
  });

  it("drops a state it does not know, and shows one it never saw", () => {
    kept.set(FILTER_KEY, '["quiet","sleeping"]');
    expect([...loadHidden()]).toEqual(["quiet"]);
  });

  it("falls back to the default when there is no storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadHidden()).toBe(DEFAULT_HIDDEN);
    expect(() => saveHidden(set("quiet"))).not.toThrow();
  });

  it("reads only the ended states it shows", () => {
    expect(endedShown(DEFAULT_HIDDEN)).toEqual([]);
    expect(endedShown(set("abandoned"))).toEqual(["done"]);
    expect(endedShown(set("done", "quiet"))).toEqual(["abandoned"]);
    expect(endedShown(set())).toEqual(["done", "abandoned"]);
  });

  it("lets through only the Tickets in shown states, in order", () => {
    const list = [ticket("A", "flagged"), ticket("B", "quiet"), ticket("C", "done"), ticket("D", "running")];
    expect(shownTickets(list, set("quiet", "done")).map((t) => t.id)).toEqual(["A", "D"]);
  });

  it("counts active Tickets by state, never ended ones", () => {
    expect(countActive([ticket("A", "quiet"), ticket("B", "quiet"), ticket("C", "running"), ticket("D", "done"), ticket("E", "abandoned")])).toEqual({ quiet: 2, running: 1 });
  });

  it("says how many states show", () => {
    expect(filterLabel(DEFAULT_HIDDEN)).toBe("8 of 10 states");
    expect(filterLabel(set())).toBe("All states");
  });

  describe("says what it is not showing", () => {
    it("names Done and Abandoned whenever hidden, uncounted", () => {
      expect(notShowing(DEFAULT_HIDDEN, {})).toBe("Not showing Done and Abandoned");
      expect(notShowing(set("abandoned"), {})).toBe("Not showing Abandoned");
    });

    it("names a hidden active state, counted, only while it holds Tickets", () => {
      expect(notShowing(set("quiet", "watching", "done", "abandoned"), { quiet: 3 })).toBe("Not showing 3 Quiet, Done and Abandoned");
      expect(notShowing(set("watching", "quiet"), { quiet: 3, watching: 1 })).toBe("Not showing 1 Watching and 3 Quiet");
      expect(notShowing(set("watching"), { quiet: 3 })).toBe("");
    });

    it("says nothing when nothing is hidden", () => {
      expect(notShowing(set(), { quiet: 3 })).toBe("");
    });
  });
});
