import { useEffect, useRef, useState } from "react";
import type { DisplayState } from "../../../api/views.ts";
import { DEFAULT_HIDDEN, ENDED, filterLabel, notShowing, STATE_GROUPS, STATE_LABEL, type Hidden } from "./filter.ts";

export interface StateFilterProps {
  hidden: Hidden;
  onChange: (hidden: Hidden) => void;
  /** Active Tickets in each state; Done and Abandoned are never counted. */
  counts: Partial<Record<DisplayState, number>>;
}

/**
 * The Ledger's state filter: what it is not showing, then a button naming how many states show, which opens a
 * checkbox per state under its group, with its pill and, for an active state, how many Tickets are in it. Reset
 * returns to the default; Show all hides nothing. An outside click or Escape closes it.
 */
export function StateFilter({ hidden, onChange, counts }: StateFilterProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (ev: MouseEvent) => {
      if (box.current && !box.current.contains(ev.target as Node)) setOpen(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const toggle = (state: DisplayState) => {
    const next = new Set(hidden);
    if (next.has(state)) next.delete(state);
    else next.add(state);
    onChange(next);
  };
  const text = notShowing(hidden, counts);

  return (
    <div className="state-filter" ref={box}>
      {text && <span data-role="not-showing">{text}</span>}
      <button type="button" className="sm" data-role="state-filter" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {filterLabel(hidden)} ▾
      </button>
      {open && (
        <div className="state-menu" role="group" aria-label="States shown">
          {STATE_GROUPS.map((g) => (
            <fieldset key={g.name}>
              <legend>{g.name}</legend>
              {g.states.map((s) => (
                <label key={s} data-state={s}>
                  <input type="checkbox" checked={!hidden.has(s)} onChange={() => toggle(s)} aria-label={STATE_LABEL[s]} />
                  <span className={"pill " + s}>{STATE_LABEL[s]}</span>
                  {!(ENDED as DisplayState[]).includes(s) && <span className="count">{counts[s] ?? 0}</span>}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="state-menu-foot">
            <button type="button" className="link" onClick={() => onChange(DEFAULT_HIDDEN)}>
              Reset
            </button>
            <button type="button" className="link" onClick={() => onChange(new Set())}>
              Show all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
