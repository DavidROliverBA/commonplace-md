// Focus mode: only the note's text, at reading width, with the line you're on kept in the middle
// of the screen (typewriter scrolling). A view state, remembered on this device; ⌘K "Focus mode"
// turns it on, and Escape or the button at the top turns it off.

import { useSyncExternalStore } from "react";

let on = (() => {
  try {
    return localStorage.getItem("cp:focus") === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

export function setFocusMode(next: boolean): void {
  on = next;
  try {
    localStorage.setItem("cp:focus", next ? "1" : "0");
  } catch {}
  listeners.forEach((f) => f());
}
export const focusModeOn = () => on;
export const useFocusMode = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => on,
  );
