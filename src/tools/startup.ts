import type { Config } from "../server/config.ts";
import type { LassoHome } from "../server/home.ts";
import type { Logger } from "../server/log.ts";
import type { Tickets } from "../store/tickets.ts";
import type { MissingTool } from "../api/views.ts";
import { findOnPath, homePipelines, missingTools, neededTools, ticketUse, type Lookup } from "./tools.ts";

/**
 * Startup's tool check: PATH only, so no network and no tool is run. Logs one
 * warning per missing needed tool and returns them for the dashboard. Never
 * throws: a missing tool, or a failure to check, must not stop Lasso starting.
 */
export function startupToolCheck(config: Config, home: LassoHome, tickets: Pick<Tickets, "list">, log: Logger, lookup: Lookup = findOnPath()): MissingTool[] {
  try {
    const needed = neededTools({ config, pipelines: homePipelines(home), tickets: tickets.list().map(ticketUse) });
    const missing = missingTools(needed, lookup).map(({ name, reasons }) => ({ name, reasons }));
    for (const tool of missing) log.warn("tool.missing", { tool: tool.name, neededBy: tool.reasons.join("; "), fix: "run lasso doctor" });
    return missing;
  } catch (error) {
    log.warn("tool.check_failed", { error });
    return [];
  }
}
