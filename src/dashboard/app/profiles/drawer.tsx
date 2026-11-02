import { useSyncExternalStore } from "react";
import { ProfileDrawer, type DrawerOptions } from "./ProfileDrawer.tsx";

export type { DrawerChoice, DrawerExtra, DrawerOptions } from "./ProfileDrawer.tsx";

interface Opened {
  key: number;
  name: string | null;
  options: DrawerOptions;
}

let opened: Opened | null = null;
let count = 0;
// The profile the open drawer holds unsaved edits to, if any.
let unsavedIn: string | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Opens the one profile drawer on `name` (default_profile when null), replacing any drawer already open once its
 * unsaved edits are dropped with consent. The way in for the Stage editor, the Ticket page and the
 * Config tiles alike; see DrawerOptions for what `options` carries.
 */
export function openProfileDrawer(name: string | null, options: DrawerOptions = {}): void {
  if (unsavedIn && !confirm(`Drop the unsaved changes to ${unsavedIn}?`)) return;
  unsavedIn = null;
  opened = { key: ++count, name, options };
  changed();
}

/** Closes the drawer at once, unsaved edits and all. */
export function closeProfileDrawer(): void {
  unsavedIn = null;
  opened = null;
  changed();
}

/** Where the one profile drawer draws while open; the app places it once, over every view. */
export function ProfileDrawerHost() {
  const open = useSyncExternalStore(subscribe, () => opened);
  if (!open) return null;
  return <ProfileDrawer key={open.key} start={open.name} options={open.options} onClose={closeProfileDrawer} onDirty={(n) => void (unsavedIn = n)} />;
}
