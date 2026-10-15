// The sidebar toggle (▯| and |▯): shows and hides the file panel on the left and the side panel
// (links and outline, and the AI) on the right, the same button on every screen. On a phone the
// left one opens the drawer.

import { Icon } from "./Icon";

const SIDES = {
  left: { icon: "panel-left", label: "Files", title: "file panel", shortcut: " (⌘\\)" },
  right: { icon: "panel", label: "Side panel", title: "side panel: links, outline and AI", shortcut: "" },
} as const;

export function PanelToggle({ side, open, onToggle }: { side: "left" | "right"; open: boolean; onToggle: () => void }) {
  const s = SIDES[side];
  return (
    <button className={`icon-btn panel-toggle${open ? " on" : ""}`} onClick={onToggle} aria-label={s.label} aria-expanded={open} title={`${open ? "Hide" : "Show"} the ${s.title}${s.shortcut}`}>
      <Icon name={s.icon} />
    </button>
  );
}
