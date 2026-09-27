import type { RunnerName } from "../pipeline/load.ts";
import type { RunnerAdapter } from "./adapter.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";

const ADAPTERS: Record<RunnerName, RunnerAdapter> = { claude: claudeAdapter, codex: codexAdapter, pi: piAdapter };

export function adapterFor(name: RunnerName): RunnerAdapter {
  return ADAPTERS[name];
}
