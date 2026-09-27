import type { RunnerName } from "../pipeline/load.ts";
import type { RunnerAdapter } from "./adapter.ts";
import { claudeAdapter } from "./claude.ts";

export class RunnerUnavailable extends Error {}

const ADAPTERS: Partial<Record<RunnerName, RunnerAdapter>> = { claude: claudeAdapter };

export function adapterFor(name: RunnerName): RunnerAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new RunnerUnavailable(`Runner ${name} has no adapter yet`);
  return adapter;
}
