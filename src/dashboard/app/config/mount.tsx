import { createRoot, type Root } from "react-dom/client";
import { ConfigPage, type ConfigPageProps } from "./ConfigPage.tsx";

let root: Root | null = null;
let visit = 0;

/** The old script's way into the React Config page: each call shows it afresh in `panel`. */
export function showConfig(panel: HTMLElement, profiles: ConfigPageProps["profiles"]): void {
  root ??= createRoot(panel);
  root.render(<ConfigPage visit={++visit} profiles={profiles} />);
}
