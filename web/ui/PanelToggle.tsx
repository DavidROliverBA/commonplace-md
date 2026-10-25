// The sidebar toggle (▯| and |▯): shows and hides the file panel on the left and the side panel
// (links and outline, and the AI) on the right, the same button on every screen. On a phone the
// left one opens the drawer. The left one can carry a dot saying the drawer holds something to
// look at (on a phone, a GitHub vault's bar lives there), with the reason in its label.

import { useSyncExternalStore } from "react";
import { Icon } from "./Icon";

export interface ToggleBadge {
  text: string;
  warn?: boolean;
}
let filesBadge: ToggleBadge | null = null;
const listeners = new Set<() => void>();
/** Put a dot on the Files toggle (null takes it away). */
export function setFilesBadge(b: ToggleBadge | null) {
  if (b?.text === filesBadge?.text && b?.warn === filesBadge?.warn) return;
  filesBadge = b;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

const SIDES = {
  left: { icon: "panel-left", label: "Files", title: "file panel", shortcut: " (⌘\\)" },
  right: { icon: "panel", label: "Side panel", title: "side panel: links, outline and AI", shortcut: "" },
} as const;

export function PanelToggle({ side, open, onToggle }: { side: "left" | "right"; open: boolean; onToggle: () => void }) {
  const s = SIDES[side];
  const badge = useSyncExternalStore(subscribe, () => (side === "left" ? filesBadge : null));
  return (
    <button
      className={`icon-btn panel-toggle${open ? " on" : ""}`}
      onClick={onToggle}
      aria-label={badge ? `${s.label}, ${badge.text}` : s.label}
      aria-expanded={open}
      title={`${open ? "Hide" : "Show"} the ${s.title}${s.shortcut}${badge ? ` (${badge.text})` : ""}`}
    >
      <Icon name={s.icon} />
      {badge && <span className={`toggle-badge${badge.warn ? " warn" : ""}`} aria-hidden="true" />}
    </button>
  );
}
