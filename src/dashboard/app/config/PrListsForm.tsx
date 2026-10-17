import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PrListsYaml } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { Setting } from "../Setting.tsx";

/**
 * The Pull Requests page's lists as their pr_lists: YAML, saved with Save PR Lists and applied at once. When config
 * changes elsewhere the text reads again, unless it holds an edit not yet saved.
 */
export function PrListsForm({ visit }: { visit: number }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = saved !== null && text !== saved;
  const edited = useRef(false);
  edited.current = dirty;
  const read = useCallback(async () => {
    try {
      const { text } = await api<PrListsYaml>("/api/config/pr-lists");
      if (edited.current) return;
      setSaved(text);
      setText(text);
    } catch {
      // A Lasso without PR Lists has nothing to edit here.
    }
  }, []);
  useEffect(() => void read(), [read, visit]);
  useEvents(["config"], () => void read());

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    showNotice("");
    setBusy(true);
    try {
      const now = await api<PrListsYaml>("/api/config/pr-lists", { method: "PUT", body: JSON.stringify({ text }) });
      showNotice("saved");
      setSaved(now.text);
      setText(now.text);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (saved === null) return null;
  return (
    <form className={dirty ? "sheet dirty" : "sheet"} data-role="config-pr-lists" onSubmit={submit}>
      <Setting title="PR Lists" about="The Pull Requests page: each list is a name with a GitHub search query and an optional limit (25 unless set, at most 100). is:pr is added, and lists are scoped to your repos unless they name repo:, org: or user:. Add search: advanced to a list for GitHub's advanced search, with AND, OR and parentheses, and hide_when_empty: true to keep a list off the page while it finds no PRs.">
        <textarea className="raw pr-lists-yaml" name="pr_lists" spellCheck={false} aria-label="pr_lists as YAML" value={text} onChange={(ev) => setText(ev.target.value)} />
      </Setting>
      <div className="savebar">
        <button className={busy ? "primary busy" : "primary"} type="submit" disabled={busy || !dirty}>
          Save PR Lists
        </button>
        <span className="state">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <span className="why">Written under pr_lists: in config.yaml; {"{}"} shows no lists.</span>
      </div>
    </form>
  );
}
