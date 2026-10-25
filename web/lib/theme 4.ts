// Light, dark, or Auto (follow the system): chosen with the button beside Trash, in Settings →
// Account, or from ⌘K, and remembered on this device. A choice sets data-theme on <html>, which
// tokens.css answers to; Auto takes it away, so the system's setting applies, with no script
// needed before the first paint. Things drawn outside CSS (Mermaid, the dataviewjs frames) ask
// `isDark()` and redraw on `onThemeChange`.

import { useSyncExternalStore } from "react";

export type Theme = "auto" | "light" | "dark";
export const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: "auto", label: "Auto", icon: "theme-auto" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

const KEY = "cp:theme";
const system = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "auto";
}
let theme: Theme = stored();

export const isDark = () => (theme === "auto" ? !!system?.matches : theme === "dark");

function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  // The browser's own bars (Safari's, the home-screen app's status bar) match the choice.
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.dataset.media ??= m.media;
    m.media = theme === "auto" ? m.dataset.media : m.dataset.media.includes(theme) ? "all" : "not all";
  }
}
apply();
system?.addEventListener?.("change", () => theme === "auto" && listeners.forEach((l) => l()));

export function setTheme(t: Theme) {
  theme = t;
  try {
    if (t === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {}
  apply();
  listeners.forEach((l) => l());
}
export const getTheme = () => theme;
/** Called when the colours change: a new choice, or the system's on Auto. */
export const onThemeChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useTheme = () => useSyncExternalStore(onThemeChange, getTheme);
/** Auto → Light → Dark → Auto: the footer button. */
export const nextTheme = (t: Theme): Theme => (t === "auto" ? "light" : t === "light" ? "dark" : "auto");
