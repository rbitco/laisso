import { useEffect, useState } from "react";
import type { VersionView } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";

/**
 * The header's version notice: a newer Lasso published, or one installed and waiting on a restart. Read on load,
 * when Lasso comes back, and when the notice changes; hidden while there is nothing to say or Lasso cannot be asked.
 */
export function VersionNotice() {
  const [text, setText] = useState<string | null>(null);
  const read = () => void api<VersionView>("/api/version").then((v) => setText(v.text), () => undefined);
  useEffect(read, []);
  useEvents(["hello", "version"], read);
  return text ? (
    <span className="version-notice" data-role="version-notice">
      {text}
    </span>
  ) : null;
}
