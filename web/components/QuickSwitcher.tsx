// Open a note by name (⌘O): fuzzy-matches titles (weighted above paths), most recently changed
// first when empty, and offers to create the note when nothing matches its title exactly. In the
// shared Modal (bare, its own box), so focus stays inside and goes back where it was on Escape;
// choosing a note lets the note take focus instead.

import { useMemo, useRef, useState } from "react";
import type { NoteSummary } from "../lib/api";
import { fuzzyScore } from "../lib/links";
import { Modal } from "../ui/Modal";

export function QuickSwitcher({ notes, canCreate, onPick, onCreate, onClose }: { notes: NoteSummary[]; canCreate: boolean; onPick: (n: NoteSummary) => void; onCreate: (title: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const results = useMemo(() => {
    if (!q.trim()) return [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 30);
    return notes
      .map((n) => ({ n, s: Math.max(fuzzyScore(q, n.title) + 50, fuzzyScore(q, n.path)) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.n);
  }, [q, notes]);
  const exact = results.some((n) => n.title.toLowerCase() === q.trim().toLowerCase());
  const showCreate = canCreate && q.trim() && !exact;
  const count = results.length + (showCreate ? 1 : 0);

  const chose = useRef(false);
  function choose(i: number) {
    if (i >= results.length && !showCreate) return;
    chose.current = true;
    if (i < results.length) onPick(results[i]!);
    else onCreate(q.trim());
  }

  return (
    <Modal title="Open note" bare top className="switcher" onClose={onClose} returnFocus={() => !chose.current}>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="switcher-list"
        aria-activedescendant={`switcher-opt-${sel}`}
        aria-label="Find or create a note"
        placeholder="Find or create a note…"
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, count - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), choose(sel));
        }}
      />
      <ul id="switcher-list" role="listbox" aria-label="Notes" tabIndex={-1}>
        {results.map((n, i) => (
          <li key={n.id} id={`switcher-opt-${i}`} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
            <span>{n.title}</span>
            {n.path.includes("/") && <small>{n.path.replace(/\/[^/]+$/, "")}</small>}
          </li>
        ))}
        {showCreate && (
          <li id={`switcher-opt-${results.length}`} role="option" aria-selected={sel === results.length} className={sel === results.length ? "on" : ""} onMouseEnter={() => setSel(results.length)} onClick={() => choose(results.length)}>
            <span>
              Create “{q.trim()}”
            </span>
            <small>new note</small>
          </li>
        )}
      </ul>
      <footer className="muted keys-hint">↑↓ to move · ↵ to open · esc to close</footer>
    </Modal>
  );
}
