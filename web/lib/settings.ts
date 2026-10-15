// Settings (F17): the one place for anything you set once and that stays set. Opened from the
// gear, the account button, ⌘K and in-context shortcuts, always at a section, so no feature
// keeps a second copy of its settings. Module state, so commands (outside React) can open it.

import { useSyncExternalStore } from "react";

export type SettingsSection = "account" | "vault" | "site" | "assistants" | "connections" | "admin";

/** null: closed. "list": open at the list of sections (on a laptop, the first one). */
let open: SettingsSection | "list" | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function openSettings(section?: SettingsSection): void {
  open = section ?? "list";
  seq++; // reopening the same section while it's open still goes back to it
  emit();
}
export function closeSettings(): void {
  open = null;
  emit();
}

type Snap = { open: SettingsSection | "list" | null; seq: number };
let snap: Snap = { open, seq };
export function useSettings(): Snap {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => (snap.open === open && snap.seq === seq ? snap : (snap = { open, seq })),
  );
}
