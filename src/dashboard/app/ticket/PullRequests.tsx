import type { PrView, TicketDetail } from "../../../api/views.ts";

/** Where the title bar's PR count scrolls to. */
const PANEL_ID = "ticket-prs";

/** Owned PRs first, then Referenced, each in the order they were linked. */
const ordered = (prs: PrView[]) => [...prs.filter((p) => p.role === "owned"), ...prs.filter((p) => p.role === "referenced")];

/** How a PR stands in a word or two: merged or closed, else what needs doing, else its checks. A Referenced PR shows only its state. */
export function prStateWord(p: PrView): string {
  if (p.state === "MERGED" || p.state === "CLOSED") return p.state.toLowerCase();
  if (p.role === "referenced" || p.state === null) return p.state ? "open" : "not read yet";
  if (p.feedback > 0) return `${p.feedback} Feedback`;
  return p.checks === "failing" ? "checks failing" : p.checks === "running" ? "checks running" : p.checks === "green" ? "checks green" : "open";
}

/** The tone a PR's state word takes, from the same reading. */
export function prTone(p: PrView): string {
  if (p.state === "MERGED") return "good";
  if (p.state === "CLOSED") return "crit";
  if (p.role === "referenced") return "muted";
  if (p.feedback > 0 || p.checks === "failing") return "crit";
  return p.checks === "running" ? "run" : "muted";
}

/** The title bar's "N Owned PRs · M Referenced", which scrolls to the Pull requests panel; nothing when the Ticket has no PRs. */
export function PrCount({ ticket: t }: { ticket: TicketDetail }) {
  if (!t.prs.length) return null;
  const owned = t.prs.filter((p) => p.role === "owned").length;
  return (
    <>
      {" · "}
      <a
        href={"#" + PANEL_ID}
        data-role="pr-count"
        onClick={(ev) => {
          ev.preventDefault();
          document.getElementById(PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      >
        {`${owned} Owned PR${owned === 1 ? "" : "s"} · ${t.prs.length - owned} Referenced`}
      </a>
    </>
  );
}

/**
 * The Ticket's linked PRs, read-only: Owned first, then Referenced. Each row has the number linking to GitHub, the
 * title, the head branch and who linked it (or whose PR it is, for a Referenced one), and a state word. Linking is
 * the CLI's, so the footer says how. Nothing when the Ticket has no PRs.
 */
export function PrPanel({ ticket: t }: { ticket: TicketDetail }) {
  if (!t.prs.length) return null;
  const rows = ordered(t.prs);
  return (
    <div className="panel" id={PANEL_ID} data-role="pr-panel">
      <h3>Pull requests</h3>
      <div className="tprs">
        {rows.map((p, i) => (
          <div className="tpr" key={p.url} data-role="pr-link-row" data-pr-role={p.role}>
            <span className="role">{i === 0 || rows[i - 1]!.role !== p.role ? (p.role === "owned" ? "Owned" : "Referenced") : ""}</span>
            <span className="what">
              <a href={p.url} target="_blank" rel="noopener">
                {"#" + p.number}
              </a>
              {p.title && " " + p.title}
              <span className="sub">{[p.head, p.role === "referenced" ? (p.author ? `${p.author}'s` : null) : `linked by ${p.source}`].filter(Boolean).join(" · ")}</span>
            </span>
            <span className={"state " + prTone(p)}>{prStateWord(p)}</span>
          </div>
        ))}
      </div>
      <div className="why">Link or unlink with lasso pr link / unlink</div>
    </div>
  );
}
