import { useId } from "react";

/** The pixel blocks that draw the speech bubble and its hanging lasso tail. */
const ROPE =
  "M200 0h49v49h-49zM250 0h49v49h-49zM300 0h49v49h-49zM350 0h49v49h-49zM400 0h49v49h-49zM450 0h49v49h-49zM100 50h49v49h-49zM150 50h49v49h-49zM500 50h49v49h-49zM550 50h49v49h-49zM50 100h49v49h-49zM600 100h49v49h-49zM0 150h49v49h-49zM650 150h49v49h-49zM0 200h49v49h-49zM650 200h49v49h-49zM0 250h49v49h-49zM650 250h49v49h-49zM50 300h49v49h-49zM600 300h49v49h-49zM100 350h49v49h-49zM150 350h49v49h-49zM500 350h49v49h-49zM550 350h49v49h-49zM200 400h49v49h-49zM300 400h49v49h-49zM350 400h49v49h-49zM400 400h49v49h-49zM450 400h49v49h-49zM250 450h49v49h-49zM150 500h49v49h-49zM200 500h49v49h-49zM150 550h49v49h-49zM200 550h49v49h-49z";
/** The three dots inside the bubble. */
const DOTS = "M200 215h52v52h-52zM320 215h52v52h-52zM440 215h52v52h-52z";

/**
 * Laisso's mark: a pixel speech bubble with a lasso tail. The rope runs from the Watching violet to the accent
 * orange, read from the theme's tokens so it follows light and dark; the dots take the ink colour.
 */
export function Logo({ className }: { className?: string }) {
  const id = "laisso-rope" + useId().replace(/[^\w-]/g, "");
  return (
    <svg className={className} viewBox="0 0 700 600" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="700" y2="0">
          <stop offset="0" style={{ stopColor: "var(--wait)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--crit)" }} />
          <stop offset="1" style={{ stopColor: "var(--accent)" }} />
        </linearGradient>
      </defs>
      <path d={ROPE} fill={`url(#${id})`} />
      <path d={DOTS} fill="var(--ink)" />
    </svg>
  );
}
