// Every task in the vault in one list: the `- [ ]` lines of every note, open or done, by note or
// by due date (📅 2026-10-12, in the common Tasks format).
// Ticking one here ticks it in its note, merged with whoever is typing there.

import { useEffect, useMemo, useState } from "react";
import { api, type NoteSummary, type Vault } from "../lib/api";
import { navigate, noteUrl } from "../lib/router";
import { formatDate } from "../lib/templates";
import { typeNamed } from "../lib/types";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { toastError } from "../ui/overlays";

interface Task {
  noteId: number;
  path: string;
  title: string;
  type: string | null;
  line: number;
  text: string;
  done: boolean;
  due: string | null;
}

type Show = "open" | "done" | "all";
type Group = "note" | "due";

interface Props {
  vault: Vault;
  notes: NoteSummary[];
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  onNavigate: () => void;
}

const today = () => formatDate(new Date(), "YYYY-MM-DD");

export function TasksPage(p: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [show, setShow] = useState<Show>(() => (localStorage.getItem("cp:tasksShow") as Show) || "open");
  const [group, setGroup] = useState<Group>(() => (localStorage.getItem("cp:tasksGroup") as Group) || "note");
  const [q, setQ] = useState("");
  const canWrite = p.vault.role !== "viewer";

  // Reload whenever a note changes anywhere in the vault.
  useEffect(() => {
    api<Task[]>(`/vaults/${p.vault.id}/tasks`).then(setTasks, toastError);
  }, [p.vault.id, p.notes]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tasks ?? []).filter((t) => (show === "all" || (show === "done") === t.done) && (!needle || t.text.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)));
  }, [tasks, show, q]);

  const groups = useMemo(() => {
    const m = new Map<string, Task[]>();
    if (group === "note") {
      for (const t of shown) m.set(String(t.noteId), [...(m.get(String(t.noteId)) ?? []), t]);
      return [...m.values()].map((list) => ({ key: list[0]!.title, note: list[0]!, list }));
    }
    const t0 = today();
    const bucket = (t: Task) => (!t.due ? "No date" : t.due < t0 ? "Overdue" : t.due === t0 ? "Today" : "Later");
    for (const t of shown) m.set(bucket(t), [...(m.get(bucket(t)) ?? []), t]);
    return ["Overdue", "Today", "Later", "No date"]
      .filter((k) => m.has(k))
      .map((key) => ({ key, note: null, list: m.get(key)!.sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9")) }));
  }, [shown, group]);

  async function tick(t: Task) {
    const done = !t.done;
    setTasks((ts) => ts?.map((x) => (x === t ? { ...x, done } : x)) ?? null); // at once
    try {
      await api(`/vaults/${p.vault.id}/notes/${t.noteId}/tasks`, { method: "PATCH", body: { line: t.line, text: t.text, done } });
    } catch (e) {
      toastError(e);
      api<Task[]>(`/vaults/${p.vault.id}/tasks`).then(setTasks, () => {});
    }
  }

  const open = (id: number) => {
    navigate(noteUrl(p.vault.id, id));
    p.onNavigate();
  };
  const openCount = (tasks ?? []).filter((t) => !t.done).length;

  return (
    <div className="tasks-page">
      <header className="note-header">
        <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
        <h1 className="note-title type-title">
          <Icon name="check" /> Tasks <span className="count">{tasks ? `${openCount} open` : ""}</span>
        </h1>
        <div className="note-actions">
          <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
        </div>
      </header>
      <div className="type-body">
        <div className="type-toolbar">
          <div className="row wrap">
            <div className="segmented" role="radiogroup" aria-label="Show">
              {(["open", "done", "all"] as Show[]).map((s) => (
                <button key={s} role="radio" aria-checked={show === s} className={show === s ? "on" : ""} onClick={() => (setShow(s), localStorage.setItem("cp:tasksShow", s))}>
                  {s === "open" ? "Open" : s === "done" ? "Done" : "All"}
                </button>
              ))}
            </div>
            <input className="type-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tasks…" aria-label="Filter tasks" />
            <select value={group} onChange={(e) => (setGroup(e.target.value as Group), localStorage.setItem("cp:tasksGroup", e.target.value))} aria-label="Group tasks">
              <option value="note">By note</option>
              <option value="due">By due date</option>
            </select>
          </div>
        </div>
        {tasks === null ? (
          <div className="loading-bar" />
        ) : shown.length === 0 ? (
          <p className="muted">
            {tasks.length === 0 ? "No tasks yet. Any “- [ ]” line in a note shows up here; add “📅 2026-10-12” to give it a due date." : show === "open" ? "Nothing left to do." : "Nothing matches."}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="type-group tasks-group">
              <h3>
                {g.note ? (
                  <button className="link" onClick={() => open(g.note!.noteId)}>
                    {g.note.type && <Icon name={typeNamed(g.note.type)?.icon ?? "shapes"} size={14} />} {g.key}
                  </button>
                ) : (
                  g.key
                )}{" "}
                <span className="count">{g.list.length}</span>
              </h3>
              <ul className="task-list">
                {g.list.map((t) => (
                  <li key={`${t.noteId}:${t.line}`} className={t.done ? "done" : ""}>
                    <input type="checkbox" checked={t.done} disabled={!canWrite} onChange={() => void tick(t)} aria-label={t.text} />
                    <span className="task-text">{t.text.replace(/📅\s*\d{4}-\d{2}-\d{2}/u, "").trim()}</span>
                    {t.due && <span className={`due${!t.done && t.due < today() ? " overdue" : ""}`}>{formatDate(new Date(`${t.due}T12:00:00`), "D MMM")}</span>}
                    {group === "due" && (
                      <button className="link task-note" onClick={() => open(t.noteId)}>
                        {t.title}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
