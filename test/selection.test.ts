import { describe, it, expect } from "vitest";
import type { SessionView, TicketDetail } from "../src/api/views.ts";
import { shownSession } from "../src/dashboard/app/ticket/selection.ts";

// Which Session a Ticket's Session pane shows for a selection from the hash (LASSO-154, LASSO-157).
const session = (id: string, stage: string): SessionView => ({ id, stage }) as SessionView;
const live = session("S4", "review");
const ticket = (sessions: SessionView[]): TicketDetail =>
  ({ session: sessions[0] ?? null, sessions, stages: ["plan", "implement", "review", "deploy"].map((name) => ({ name })) }) as unknown as TicketDetail;
// Newest first, as the API lists them.
const t = ticket([live, session("S3", "implement"), session("S2", "plan"), session("S1", "plan")]);
const shown = (over: object) => ({ past: false, empty: false, newer: null, ...over });

describe("the Session shown", () => {
  it("is the live Session with nothing selected", () => {
    expect(shownSession(t, null)).toEqual(shown({ session: live, stage: null }));
  });

  it("is the Session selected, past unless it is the live one, narrowed to its Stage", () => {
    expect(shownSession(t, { session: "S1" })).toEqual(shown({ session: t.sessions[3], past: true, stage: "plan" }));
    expect(shownSession(t, { session: "S4" })).toEqual(shown({ session: live, stage: "review" }));
  });

  it("is a selected Stage's newest Session", () => {
    expect(shownSession(t, { stage: "plan" })).toEqual(shown({ session: t.sessions[2], past: true, stage: "plan" }));
    expect(shownSession(t, { stage: "review" })).toEqual(shown({ session: live, stage: "review" }));
  });

  it("falls back to the live Session for a Session id the Ticket lacks, or a Stage its Version lacks", () => {
    expect(shownSession(t, { session: "nope" })).toEqual(shown({ session: live, stage: null }));
    expect(shownSession(t, { stage: "ship" })).toEqual(shown({ session: live, stage: null }));
  });

  it("is none, and empty, for a Stage with no Sessions yet", () => {
    expect(shownSession(t, { stage: "deploy" })).toEqual(shown({ session: null, empty: true, stage: "deploy" }));
    expect(shownSession(ticket([]), { stage: "plan" })).toEqual(shown({ session: null, empty: true, stage: "plan" }));
    expect(shownSession(ticket([]), null)).toEqual(shown({ session: null, stage: null }));
  });
});

describe("a Session starting after the selection", () => {
  // implement #2 starts while plan, a Session, or an empty Stage is shown: the selection was made when S4 was live.
  const started = session("S5", "implement");
  const later = ticket([started, ...t.sessions]);

  it("leaves a selected Session or Stage where it was, and is named as newer", () => {
    expect(shownSession(later, { session: "S2" }, "S4")).toEqual(shown({ session: t.sessions[2], past: true, stage: "plan", newer: started }));
    expect(shownSession(later, { stage: "plan" }, "S4")).toEqual(shown({ session: t.sessions[2], past: true, stage: "plan", newer: started }));
  });

  it("does not move a selected Stage to its own new Session: the one live at the time is now past", () => {
    expect(shownSession(later, { stage: "implement" }, "S4")).toEqual(shown({ session: t.sessions[1], past: true, stage: "implement", newer: started }));
    expect(shownSession(later, { stage: "review" }, "S4")).toEqual(shown({ session: live, past: true, stage: "review", newer: started }));
  });

  it("keeps an empty Stage empty, even when the new Session is of that Stage", () => {
    const deploying = ticket([session("S5", "deploy"), ...t.sessions]);
    expect(shownSession(deploying, { stage: "deploy" }, "S4")).toEqual(shown({ session: null, empty: true, stage: "deploy", newer: deploying.sessions[0] }));
    // A Ticket with no Sessions when the Stage was chosen.
    const first = ticket([session("S1", "plan")]);
    expect(shownSession(first, { stage: "plan" }, null)).toEqual(shown({ session: null, empty: true, stage: "plan", newer: first.sessions[0] }));
  });

  it("is nothing while the live Session is the one the selection knew, or with nothing selected", () => {
    expect(shownSession(later, { stage: "plan" }, "S5").newer).toBeNull();
    expect(shownSession(later, null, "S4")).toEqual(shown({ session: started, stage: null }));
  });
});
