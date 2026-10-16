import { describe, it, expect } from "vitest";
import type { SessionView, TicketDetail } from "../src/api/views.ts";
import { shownSession } from "../src/dashboard/app/ticket/selection.ts";

// Which Session a Ticket's Session pane shows for a selection from the hash (LASSO-154).
const session = (id: string, stage: string): SessionView => ({ id, stage }) as SessionView;
const live = session("S4", "review");
const ticket = (sessions: SessionView[]): TicketDetail =>
  ({ session: sessions[0] ?? null, sessions, stages: ["plan", "implement", "review", "deploy"].map((name) => ({ name })) }) as unknown as TicketDetail;
// Newest first, as the API lists them.
const t = ticket([live, session("S3", "implement"), session("S2", "plan"), session("S1", "plan")]);

describe("the Session shown", () => {
  it("is the live Session with nothing selected", () => {
    expect(shownSession(t, null)).toEqual({ session: live, past: false, stage: null });
  });

  it("is the Session selected, past unless it is the live one, narrowed to its Stage", () => {
    expect(shownSession(t, { session: "S1" })).toEqual({ session: t.sessions[3], past: true, stage: "plan" });
    expect(shownSession(t, { session: "S4" })).toEqual({ session: live, past: false, stage: "review" });
  });

  it("is a selected Stage's newest Session", () => {
    expect(shownSession(t, { stage: "plan" })).toEqual({ session: t.sessions[2], past: true, stage: "plan" });
    expect(shownSession(t, { stage: "review" })).toEqual({ session: live, past: false, stage: "review" });
  });

  it("falls back to the live Session for a Session id the Ticket lacks, or a Stage its Version lacks", () => {
    expect(shownSession(t, { session: "nope" })).toEqual({ session: live, past: false, stage: null });
    expect(shownSession(t, { stage: "ship" })).toEqual({ session: live, past: false, stage: null });
  });

  it("keeps the live Session in the pane for a Stage with no Sessions yet, narrowed to it", () => {
    expect(shownSession(t, { stage: "deploy" })).toEqual({ session: live, past: false, stage: "deploy" });
  });

  it("is none for a Ticket with no Sessions", () => {
    expect(shownSession(ticket([]), null)).toEqual({ session: null, past: false, stage: null });
    expect(shownSession(ticket([]), { stage: "plan" })).toEqual({ session: null, past: false, stage: "plan" });
  });
});
