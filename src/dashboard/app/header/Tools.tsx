import { useEffect, useState } from "react";
import type { Health, MissingTool } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";

/**
 * The header's line naming the tools Laisso needs that PATH lacked when it started, and what needs each; hidden when
 * none are missing. Read once on load and again when Laisso comes back, since only a start checks PATH.
 */
export function MissingTools() {
  const [missing, setMissing] = useState<MissingTool[]>([]);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    api<Health>("/api/health").then(
      (health) => live && setMissing(health.missingTools ?? []),
      () => undefined,
    );
    return () => void (live = false);
  }, [reads]);
  useEvents(["hello"], () => setReads((n) => n + 1));
  if (!missing.length) return null;
  return (
    <p data-role="missing-tools" className="notice tools-notice">
      {missing.map((t) => `${t.name} not found on PATH (${t.reasons.join("; ")})`).join(" · ")}; run laisso doctor
    </p>
  );
}
