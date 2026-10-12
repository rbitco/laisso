import { createRoot, type Root } from "react-dom/client";
import { ProfileDrawer, type DrawerOptions } from "./ProfileDrawer.tsx";

export type { DrawerChoice, DrawerExtra, DrawerOptions } from "./ProfileDrawer.tsx";

let host: HTMLElement | null = null;
let root: Root | null = null;
let opened = 0;
// The profile the open drawer holds unsaved edits to, if any.
let unsavedIn: string | null = null;

/**
 * Opens the one profile drawer on `name` (default_profile when null), replacing any drawer already open once its
 * unsaved edits are dropped with consent. The way in for the Stage editor, the old script's Ticket page and the
 * Config tiles alike; see DrawerOptions for what `options` carries.
 */
export function openProfileDrawer(name: string | null, options: DrawerOptions = {}): void {
  if (unsavedIn && !confirm(`Drop the unsaved changes to ${unsavedIn}?`)) return;
  unsavedIn = null;
  if (!host || !root) {
    host = document.createElement("div");
    host.dataset.role = "profile-drawer-host";
    root = createRoot(host);
  }
  if (!host.isConnected) document.body.appendChild(host);
  root.render(<ProfileDrawer key={++opened} start={name} options={options} onClose={closeProfileDrawer} onDirty={(n) => void (unsavedIn = n)} />);
}

/** Closes the drawer at once, unsaved edits and all. */
export function closeProfileDrawer(): void {
  unsavedIn = null;
  root?.render(null);
}
