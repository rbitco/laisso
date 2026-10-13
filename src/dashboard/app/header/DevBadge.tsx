import { useEffect, useState } from "react";
import type { Health } from "../../../api/views.ts";
import { isDevVersion } from "../../../version.ts";
import { api } from "../api.ts";

const DEV_TITLE = "(dev) ";

/**
 * A "dev" badge beside the header's name, and "(dev)" before the tab's title, while the Lasso that served the page is
 * a dev build: an installed Lasso and a dev clone's can be open side by side, and this tells them apart. Nothing until
 * /api/health answers, and nothing for a release.
 */
export function DevBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api<Health>("/api/health").then(setHealth, () => {});
  }, []);
  const dev = health !== null && isDevVersion(health.version);
  useEffect(() => {
    if (!dev || document.title.startsWith(DEV_TITLE)) return;
    document.title = DEV_TITLE + document.title;
    return () => {
      if (document.title.startsWith(DEV_TITLE)) document.title = document.title.slice(DEV_TITLE.length);
    };
  }, [dev]);
  if (!dev) return null;
  return (
    <span className="dev-badge" data-role="dev-badge" title={`dev build, Lasso home ${health.home}`}>
      dev
    </span>
  );
}
