import type { StageProfileView, TicketDetail } from "../../../api/views.ts";
import { ticketProfileView } from "../../metro.ts";
import { api } from "../api.ts";
import { openProfileDrawer } from "../profiles/drawer.tsx";
import { ProfileButton } from "../profiles/ProfileButton.tsx";
import { ticketRoute } from "./ticket.ts";

/**
 * Each Runner Stage of an active Ticket that isn't done, with the profile its next Session runs under (LASSO-75). The
 * button opens the profile drawer on the Ticket's repo; "Use <profile> for this Ticket's <stage>" sets the Stage's
 * override, which wins over the Pipeline's choice from the next Session until "Clear override". Nothing when none.
 */
export function StageProfiles({ ticket: t, refresh }: { ticket: TicketDetail; refresh: () => Promise<void> }) {
  if (t.state !== "active") return null;
  const rows = t.profiles.filter((p) => t.stages.findIndex((s) => s.name === p.stage) >= t.stage.index);
  if (!rows.length) return null;
  return (
    <div className="panel" data-role="stage-profiles">
      <h3>Agent Profiles</h3>
      <div className="stage-profiles">
        {rows.map((p) => (
          <div key={p.stage}>
            <div className="stage-name">{p.stage}</div>
            <StageProfile ticket={t} stage={p} refresh={refresh} />
          </div>
        ))}
      </div>
      <div className="why">an override applies from the Stage's next Session, retries and Rounds included; a running Session keeps its own</div>
    </div>
  );
}

function StageProfile({ ticket: t, stage: p, refresh }: { ticket: TicketDetail; stage: StageProfileView; refresh: () => Promise<void> }) {
  const v = ticketProfileView(p);
  const route = ticketRoute(t.id) + "/stages/" + encodeURIComponent(p.stage) + "/profile";
  // The drawer closes once either choice is written.
  const chose = (init: RequestInit) => async () => {
    await api(route, init);
    await refresh();
  };
  const open = () =>
    openProfileDrawer(v.name, {
      scope: t.repo,
      context: `Stage ${p.stage} of Ticket ${t.reference || t.shortId}`,
      extra: (name) => ({
        role: "ticket-profile-choice",
        why: "this Ticket only; applies from the Stage's next Session",
        choices: [
          { role: "profile-use", primary: true, label: `Use ${name} for this Ticket's ${p.stage}`, act: chose({ method: "PUT", body: JSON.stringify({ profile: name }) }) },
          { role: "profile-clear", label: "Clear override", hidden: !v.overridden, act: chose({ method: "DELETE" }) },
        ],
      }),
      onChange: () => void refresh(),
    });
  return (
    <ProfileButton
      label={v.label + "  ✎"}
      badge={
        v.overridden && (
          <span className="pf-overridden" data-role="overridden">
            overridden
          </span>
        )
      }
      headless={v.headless}
      human={v.human}
      role="ticket-stage-profile"
      stage={p.stage}
      onClick={open}
    />
  );
}
