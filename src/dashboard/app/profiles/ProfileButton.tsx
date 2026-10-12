import type { ReactNode } from "react";

export interface ProfileButtonProps {
  /** The first line: the profile it runs, then anything the caller adds, such as "(unsaved)". */
  label: string;
  /** What follows the label on its line, such as the Ticket page's "overridden". */
  badge?: ReactNode;
  /** Each mode's resolved line, or why the profile does not resolve. */
  headless: string;
  human: string;
  role: string;
  /** The Stage the button belongs to, when it names one. */
  stage?: string;
  title?: string;
  onClick: () => void;
}

/**
 * A Runner Stage's profile as a button: the profile it runs over each mode's resolved line. The Stage editor and the
 * Ticket page both draw it, and both open the profile drawer from it.
 */
export function ProfileButton({ label, badge, headless, human, role, stage, title, onClick }: ProfileButtonProps) {
  return (
    <button type="button" className="pf-pickbtn" data-role={role} data-stage={stage} title={title} onClick={onClick}>
      <span className="pf-pickname">
        {label}
        {badge}
      </span>
      <span className="pf-summary" data-role="stage-profile-headless">
        {"headless  " + headless}
      </span>
      <span className="pf-summary" data-role="stage-profile-human">
        {"human     " + human}
      </span>
    </button>
  );
}
