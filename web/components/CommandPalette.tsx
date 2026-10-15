// ⌘K / ⌘P: every action that applies right now, from the one list in web/lib/commands.ts.

import { useMemo, useState } from "react";
import { available, type Command, currentCtx, type Group } from "../lib/commands";
import { fuzzyScore } from "../lib/links";
import { Icon } from "../ui/Icon";

const ORDER: Group[] = ["Insert", "Note", "View", "Create", "Go", "Vault", "Settings"];

/** Each word of the query must match the command, in any order ("account settings" finds
 *  Settings → Account); a match in the title counts for more. -Infinity if a word doesn't match. */
export function commandScore(q: string, c: Pick<Command, "title" | "group" | "keywords">): number {
  const hay = `${c.group} ${c.title} ${c.keywords ?? ""}`;
  let total = 0;
  for (const w of q.trim().split(/\s+/)) {
    const s = Math.max(fuzzyScore(w, c.title) + 50, fuzzyScore(w, hay));
    if (s === -Infinity) return -Infinity;
    total += s;
  }
  return total;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const all = useMemo(() => available(), []);
  const results = useMemo(() => {
    if (!q.trim()) return [...all].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
    return all
      .map((c) => ({ c, s: commandScore(q, c) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [q, all]);

  function run(c: Command | undefined) {
    if (!c) return;
    onClose();
    // After the palette has gone, so focus lands where the command puts it.
    requestAnimationFrame(() => (c.href ? (location.href = c.href(currentCtx())) : c.run(currentCtx())));
  }

  return (
    <div className="modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher palette" role="dialog" aria-label="Commands">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results.length ? `palette-opt-${sel}` : undefined}
          placeholder="Type a command…"
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            else if (e.key === "Enter") (e.preventDefault(), run(results[sel]));
            else if (e.key === "Escape") onClose();
          }}
          aria-label="Command"
        />
        <ul id="palette-list" role="listbox" aria-label="Commands" tabIndex={-1}>
          {results.map((c, i) => (
            <li key={c.id} id={`palette-opt-${i}`} role="option" aria-selected={i === sel} className={`${i === sel ? "on" : ""}${c.danger ? " danger" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              {c.icon && <Icon name={c.icon} size={16} />}
              <span className="palette-title">{c.title}</span>
              {c.shortcut ? <kbd>{c.shortcut}</kbd> : <small>{c.group}</small>}
            </li>
          ))}
          {results.length === 0 && (
            <li className="muted" role="option" aria-selected={false} aria-disabled="true">
              No command by that name
            </li>
          )}
        </ul>
        <footer className="muted keys-hint">↑↓ to move · ↵ to run · esc to close · / in a note for blocks</footer>
      </div>
    </div>
  );
}
