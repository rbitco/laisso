import { useRef, useState } from "react";
import type { TicketDetail, Trigger } from "../../../api/views.ts";
import { showNotice } from "../notice.tsx";
import { openProfileDrawer } from "../profiles/drawer.tsx";
import { AbandonPopover } from "./Abandon.tsx";
import { MarkDoneMenu } from "./MarkDone.tsx";
import { message, pullTrigger, type ArtifactProblem } from "./ticket.ts";

const PRIMARY = new Set<string>(["terminal", "start", "retry"]);

/**
 * The levers on a Ticket. Mark done met with a missing artifact offers to advance anyway, inline; Extend opens the
 * Budget editor; Abandon opens a popover to choose which open Owned PRs it closes; Check PR now runs a tick. `refresh`
 * follows a pull that went through.
 */
export function Triggers({ ticket: t, onExtend, refresh }: { ticket: TicketDetail; onExtend: () => void; refresh: () => Promise<void> }) {
  // The lever being pulled; every lever waits on it.
  const [busy, setBusy] = useState<string | null>(null);
  const [abandoning, setAbandoning] = useState(false);
  // The Abandon lever and its popover: a click outside both closes the popover.
  const abandonBox = useRef<HTMLDivElement>(null);
  // The Mark done menu on a human or taken-over Stage (LASSO-198), and the lever with it.
  const [marking, setMarking] = useState(false);
  const doneBox = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<{ action: string; problem: ArtifactProblem } | null>(null);

  const pull = async (action: string, body: object = {}) => {
    setBusy(action);
    setAbandoning(false);
    setMarking(false);
    try {
      const refused = await pullTrigger(t.id, action, body);
      if (refused) {
        setProblem({ action, problem: refused });
        return;
      }
      setProblem(null);
      await refresh();
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(null);
    }
  };

  const press = (trigger: Trigger) => {
    if (trigger.action === "extend") onExtend();
    else if (trigger.action === "done" && t.markDone) setMarking((m) => !m);
    else if (trigger.action !== "abandon") void pull(trigger.action);
    else setAbandoning((a) => !a);
  };

  const lever = (action: string, label: string, primary: boolean, onClick: () => void, extra: { role?: string; unavailable?: string } = {}) => (
    <button
      key={action}
      type="button"
      className={"sm" + (primary ? " primary" : "") + (busy === action ? " busy" : "")}
      data-action={action}
      data-role={extra.role}
      disabled={!!extra.unavailable || busy !== null}
      title={extra.unavailable}
      onClick={onClick}
    >
      {label}
    </button>
  );

  // "retry with…" on a Flagged Runner Stage: pick a profile in the drawer, which sets the Stage's override and retries.
  const stageProfile = t.profiles.find((p) => p.stage === t.stage.name);
  const retryWith = () =>
    openProfileDrawer(stageProfile!.profile, {
      scope: t.repo,
      context: `Retry Stage ${t.stage.name} of Ticket ${t.label} under another profile; it stays this Stage's override until cleared`,
      extra: (name) => ({
        role: "retry-with-choice",
        choices: [
          {
            role: "profile-retry",
            primary: true,
            label: `Retry ${t.stage.name} with ${name}`,
            act: async () => {
              await pullTrigger(t.id, "retry", { profile: name });
              await refresh();
            },
          },
        ],
      }),
    });

  return (
    <div className="triggers" data-role="triggers">
      {t.triggers.map((trigger) => {
        // A lever on show that cannot be pulled (Resume on another Runner) stays disabled and says why below.
        const button = lever(trigger.action, trigger.label, PRIMARY.has(trigger.action), () => press(trigger), { unavailable: trigger.unavailable });
        if (trigger.action === "done" && t.markDone) {
          return (
            <div key="done" className="done-menu" ref={doneBox}>
              {button}
              {marking && <MarkDoneMenu ticket={t} menu={t.markDone} within={doneBox} busy={busy !== null} onDone={(body) => void pull("done", body)} onSent={refresh} onClose={() => setMarking(false)} />}
            </div>
          );
        }
        if (trigger.action !== "abandon") return button;
        return (
          <div key="abandon" className="abandon" ref={abandonBox}>
            {button}
            {abandoning && <AbandonPopover prs={t.prs} within={abandonBox} busy={busy !== null} onConfirm={(close) => void pull("abandon", { close })} onClose={() => setAbandoning(false)} />}
          </div>
        );
      })}
      {/* Check PR now belongs to the repeating Stage: a tick there fetches Feedback and opens a Round (spec: the title bar). */}
      {t.state === "active" && t.prs.some((p) => p.role === "owned") && t.stage.repeat && lever("check", "Check PR now", false, () => void pull("check"), { role: "check-pr" })}
      {t.flag && stageProfile && t.triggers.some((x) => x.action === "retry") && lever("retry-with", "retry with…", false, retryWith, { role: "retry-with" })}
      {t.triggers
        .filter((x) => x.unavailable)
        .map((x) => (
          <div key={"why-" + x.action} className="why" data-role="unavailable">
            {x.label + " is unavailable: " + x.unavailable}
          </div>
        ))}
      {problem && (
        <div className="override" data-role="override">
          <span>{"artifact " + problem.problem.artifact + " is missing: " + problem.problem.detail}</span>
          <button type="button" className="sm" disabled={busy !== null} onClick={() => void pull(problem.action, { override: true })}>
            Advance anyway
          </button>
        </div>
      )}
    </div>
  );
}
