// The theme button beside Trash: Auto (follow the system) → Light → Dark, remembered on this
// device (web/lib/theme.ts). Its icon shows the current choice and its label says what a press
// does next. Settings → Account and ⌘K offer the same three.

import { nextTheme, setTheme, THEMES, useTheme } from "../lib/theme";
import { Icon } from "../ui/Icon";

export function ThemeButton() {
  const theme = useTheme();
  const now = THEMES.find((t) => t.id === theme)!;
  const next = THEMES.find((t) => t.id === nextTheme(theme))!;
  const words = now.id === "auto" ? "Theme: Auto, following the system" : `Theme: ${now.label}`;
  return (
    <button className="icon-btn" onClick={() => setTheme(next.id)} title={`${words}. Press for ${next.label}`} aria-label={`${words}. Press for ${next.label}`}>
      <Icon name={now.icon} size={16} />
    </button>
  );
}
