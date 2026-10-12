import { useEffect, useState } from "react";
import type { TicketDetail, Trigger } from "../../../api/views.ts";
import { showNotice } from "../notice.tsx";
import { openProfileDrawer } from "../profiles/drawer.tsx";
import { message, pullTrigger, type ArtifactProblem } from "./ticket.ts";

/** How long Abandon waits for its second press. */
const ARMED_MS = 4000;

const PRIMARY = new Set<string>(["terminal", "start", "retry"]);

/**
 * The levers on a Ticket. Mark done met with a missing artifact offers to advance anyway, inline; Extend opens the
 * Budget editor; Abandon asks for a second press; Check PR now runs a tick. `refresh` follows a pull that went through.
 */
export function Triggers({ ticket: t, onExtend, refresh }: { ticket: TicketDetail; onExtend: () => void; refresh: () => Promise<void> }) {
  // The lever being pulled; every lever waits on it.
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [problem, setProblem] = useState<{ action: string; problem: ArtifactProblem } | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const pull = async (action: string, body: object = {}) => {
    setBusy(action);
    setArmed(false);
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
    else if (trigger.action !== "abandon") void pull(trigger.action);
    else if (armed) void pull("abandon");
    else setArmed(true);
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
      context: `Retry Stage ${t.stage.name} of Ticket ${t.reference || t.shortId} under another profile; it stays this Stage's override until cleared`,
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
      {t.triggers.map((trigger) =>
        // A lever on show that cannot be pulled (Resume on another Runner) stays disabled and says why below.
        lever(trigger.action, trigger.action === "abandon" && armed ? "Abandon for sure?" : trigger.label, PRIMARY.has(trigger.action), () => press(trigger), { unavailable: trigger.unavailable }),
      )}
      {/* Check PR now belongs to the repeating Stage: a tick there fetches Feedback and opens a Round (spec: the title bar). */}
      {t.state === "active" && t.pr && t.stage.repeat && lever("check", "Check PR now", false, () => void pull("check"), { role: "check-pr" })}
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
