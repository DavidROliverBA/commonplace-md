// On a phone, the note gets the screen while you read or write: scrolling down tucks the note's
// header away and scrolling up (or reaching the top) brings it back, as Safari does; the find
// button steps aside while the header is away and for a moment after each keystroke. NoteView
// says what's happening; App puts `chrome-hidden` and `typing` on `.app` for styles/phone.css.

import { useSyncExternalStore } from "react";

let state = { hidden: false, typing: false };
const listeners = new Set<() => void>();
const set = (next: Partial<typeof state>) => {
  if (Object.entries(next).every(([k, v]) => state[k as keyof typeof state] === v)) return;
  state = { ...state, ...next };
  listeners.forEach((f) => f());
};

export const setChromeHidden = (hidden: boolean) => set({ hidden });

let typingTimer: ReturnType<typeof setTimeout> | undefined;
/** A keystroke in the note: the find button stays out of the way until typing pauses. */
export function noteTyping(): void {
  set({ typing: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => set({ typing: false }), 1500);
}

export function resetChrome(): void {
  clearTimeout(typingTimer);
  set({ hidden: false, typing: false });
}

export const usePhoneChrome = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => state,
  );
