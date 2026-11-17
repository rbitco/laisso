import { ApiError } from "../api.ts";

/** A save or delete the server refused because it would stop other Pipelines loading (LASSO-219), and how to go ahead. */
export interface Breaking {
  message: string;
  go: () => void;
}

/** The server's message when `error` is such a refusal, else null. */
export function wouldBreak(error: unknown): string | null {
  return error instanceof ApiError && error.status === 409 ? error.message : null;
}

/** The query that confirms a write: sent again with it, a write that breaks other Pipelines goes ahead. */
export const confirmQuery = (confirm: boolean) => (confirm ? "?confirm=1" : "");

/** "Saving default breaks 1 Pipeline: …", with the action anyway and Cancel, which leaves the file as it is. */
export function BreakConfirm({ breaking, action, onCancel }: { breaking: Breaking; action: string; onCancel: () => void }) {
  return (
    <div className="card problem" data-role="break-confirm" role="alertdialog" aria-label="This breaks other Pipelines">
      <div className="why">{breaking.message}</div>
      <div className="bar" style={{ marginTop: 10 }}>
        <button type="button" className="danger" onClick={breaking.go}>
          {action}
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
