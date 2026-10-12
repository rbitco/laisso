import { createRoot, type Root } from "react-dom/client";
import { PipelinesPage } from "./PipelinesPage.tsx";

let root: Root | null = null;
let visit = 0;

/**
 * The old script's way into the React Pipelines page: each call shows it afresh in `panel`, open on Pipeline `name`,
 * on its frozen `version` when one is given, or on neither.
 */
export function showPipelines(panel: HTMLElement, name: string | null, version: number | null): void {
  root ??= createRoot(panel);
  root.render(<PipelinesPage name={name} version={version} visit={++visit} />);
}
