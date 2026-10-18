// Commonplace as one HTML file: open a folder of Markdown files and edit them in the app's editor,
// with the file panel, wikilinks, backlinks, outline, search and the four view modes. No server,
// no account: the files are the notes (standalone/vault.ts).

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { findWikiLinks, headings, isAttachmentPath } from "../src/markdown";
import type { NoteSummary } from "../web/lib/api";
import { refreshDataview } from "../web/lib/dataview";
import { hydrate } from "../web/lib/embeds";
import { resolveLocal } from "../web/lib/links";
import { renderMarkdown, toggleTask } from "../web/lib/render";
import { HelpHost } from "../web/components/Help";
import { QuickSwitcher } from "../web/components/QuickSwitcher";
import { openHelp } from "../web/lib/help";
import { Icon } from "../web/ui/Icon";
import { Menu } from "../web/ui/Menu";
import { confirmDialog, Overlays, promptDialog, toast, toastError } from "../web/ui/overlays";
import { PanelToggle } from "../web/ui/PanelToggle";
import { Editor, type EditorHandle } from "./Editor";
import * as vault from "./vault";

type Mode = "edit" | "source" | "split" | "read";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`cp-standalone-${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`cp-standalone-${k}`, v);
    } catch {
      // Not kept (private window); it's only a preference.
    }
  },
};

const useNotes = () => useSyncExternalStore(vault.subscribe, vault.allNotes);
const narrow = () => window.matchMedia("(max-width: 820px)").matches;

export function App() {
  const notes = useNotes();
  const [open, setOpen] = useState(vault.isOpen());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [left, setLeft] = useState(() => !narrow());
  const [right, setRight] = useState(() => !narrow() && store.get("right") !== "0");
  const [switcher, setSwitcher] = useState(false);
  const [tab, setTab] = useState<"files" | "search" | "tags">("files");
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => vault.onSaveError((e) => toastError(e)), []);
  useEffect(() => void requestAnimationFrame(() => setReady(true)), []);

  const openNote = (n: NoteSummary | undefined) => {
    if (!n) return;
    setActiveId(n.id);
    if (narrow()) setLeft(false);
  };

  async function opened() {
    setOpen(true);
    const all = vault.allNotes();
    const last = all.find((n) => n.path === store.get(`last:${vault.vaultName()}`));
    openNote(last ?? [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]);
  }

  useEffect(() => {
    const n = notes.find((x) => x.id === activeId);
    if (n) store.set(`last:${vault.vaultName()}`, n.path);
  }, [activeId, notes]);

  async function newNote(folder = "") {
    const name = await promptDialog({ title: "New note", label: "Title", value: "Untitled", action: "Create" });
    if (!name) return;
    try {
      openNote(await vault.createNote(folder ? `${folder}/${name}` : name, ""));
    } catch (e) {
      toastError(e);
    }
  }

  /** A [[link]]: open its note, or make it (beside the note it was in) when there isn't one. */
  async function openLink(target: string) {
    const name = target.split("#")[0]!.trim();
    const hit = resolveLocal(vault.allNotes(), name);
    if (hit) return openNote(hit);
    if (!name) return;
    try {
      const from = vault.allNotes().find((n) => n.id === activeId)?.path ?? "";
      const folder = name.includes("/") ? "" : from.replace(/\/?[^/]*$/, "");
      openNote(await vault.createNote(folder ? `${folder}/${name}` : name));
      toast(`Made a new note, ${name}`);
    } catch (e) {
      toastError(e);
    }
  }

  // ⌘O opens a note by name, ⌘\ the file panel, ⌘S saves now.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !vault.isOpen()) return;
      const k = e.key.toLowerCase();
      if (k === "o" || k === "p") (e.preventDefault(), setSwitcher(true));
      else if (k === "\\") (e.preventDefault(), setLeft((v) => !v));
      else if (k === "s") (e.preventDefault(), void vault.flush());
      else if (k === "f" && e.shiftKey) (e.preventDefault(), setLeft(true), setTab("search"));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Unsaved work: writes still pending, or (without folder access) changes not downloaded.
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (vault.dirtyCount() === 0) return;
      void vault.flush();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, []);

  useAttachmentUrls();

  if (!open) return <Welcome onOpened={() => void opened()} />;

  const active = notes.find((n) => n.id === activeId);
  const cls = `app${left ? " left-open" : ""}${right && active ? " right-open" : ""}${ready ? " ready" : ""}`;
  return (
    <div className={cls}>
      <Sidebar
        notes={notes}
        activeId={activeId}
        tab={tab}
        setTab={setTab}
        query={query}
        setQuery={setQuery}
        onOpen={openNote}
        onNewNote={(f) => void newNote(f)}
        onSwitch={() => (setOpen(false), setActiveId(null))}
      />
      {narrow() && (left || (right && active)) && <div className="scrim" onClick={() => (setLeft(false), setRight(false))} />}
      {active ? (
        <NoteScreen
          key={active.id}
          note={active}
          notes={notes}
          leftOpen={left}
          rightOpen={right}
          onToggleLeft={() => setLeft((v) => !v)}
          onToggleRight={() => setRight((v) => (store.set("right", v ? "0" : "1"), !v))}
          onOpenLink={(t) => void openLink(t)}
          onOpen={openNote}
          onTag={(t) => (setQuery(`#${t}`), setTab("search"), setLeft(true))}
          onDeleted={() => setActiveId(null)}
        />
      ) : (
        <main className="main">
          <div className="empty-state">
            <p>{notes.length ? "Pick a note on the left, or press ⌘O to open one by name." : "This folder has no Markdown files yet."}</p>
            <button className="primary" onClick={() => void newNote()}>
              <Icon name="plus" /> New note
            </button>
          </div>
        </main>
      )}
      {switcher && (
        <QuickSwitcher notes={notes} canCreate onPick={(n) => (setSwitcher(false), openNote(n))} onCreate={(t) => (setSwitcher(false), void openLink(t))} onClose={() => setSwitcher(false)} />
      )}
      <HelpHost />
      <Overlays />
    </div>
  );
}

// ── welcome ───────────────────────────────────────────────────────────────────────────

function Welcome({ onOpened }: { onOpened: () => void }) {
  const [last, setLast] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folders = vault.supportsFolders();

  useEffect(() => void vault.lastFolder().then(setLast), []);

  async function run(f: () => Promise<void>) {
    setBusy(true);
    try {
      await f();
      onOpened();
    } catch (e) {
      // Closing the picker isn't an error.
      if ((e as Error)?.name !== "AbortError") toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const pickFolder = () => run(async () => vault.openFolder(await (window as any).showDirectoryPicker({ id: "commonplace", mode: "readwrite" })));
  const reopen = () =>
    run(async () => {
      const ok = (await (last as any).requestPermission({ mode: "readwrite" })) === "granted";
      if (!ok) throw new Error("Commonplace needs permission to edit that folder.");
      await vault.openFolder(last!);
    });
  const fromInput = (input: HTMLInputElement, label: string) => {
    const list = [...(input.files ?? [])];
    input.value = "";
    if (list.length) void run(() => vault.openFiles(list, label));
  };

  return (
    <div
      className="login"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const list = [...e.dataTransfer.files].filter((f) => /\.md$/i.test(f.name) || f.type.startsWith("image/"));
        if (list.length) void run(() => vault.openFiles(list, "Dropped files"));
        else toast("Drop .md files here (a folder needs the Open buttons).", { tone: "error" });
      }}
    >
      <div className="login-card standalone-welcome">
        <div className="brand">
          <Icon name="book" size={28} />
          <h1>Commonplace</h1>
        </div>
        <p className="muted">A Markdown editor for a folder of notes. Your files stay on this computer: nothing is uploaded.</p>
        {folders ? (
          <>
            {last && (
              <button className="primary" disabled={busy} onClick={() => void reopen()}>
                <Icon name="folder" /> Reopen {last.name}
              </button>
            )}
            <button className={last ? "" : "primary"} disabled={busy} onClick={() => void pickFolder()}>
              <Icon name="folder" /> Open a folder
            </button>
            <p className="muted small">Changes are saved to the files as you type.</p>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => picker.current?.click()}>
              <Icon name="folder" /> Open a folder
            </button>
            <button disabled={busy} onClick={() => filePicker.current?.click()}>
              <Icon name="file" /> Open files
            </button>
            <p className="muted small">This browser can't write to a folder, so edits stay in this tab: use Download changes to save them. Chrome or Edge saves to the files directly.</p>
          </>
        )}
        <input
          ref={picker}
          type="file"
          hidden
          {...{ webkitdirectory: "" }}
          multiple
          onChange={(e) => fromInput(e.currentTarget, e.currentTarget.files?.[0]?.webkitRelativePath.split("/")[0] || "Folder")}
        />
        <input ref={filePicker} type="file" hidden multiple accept=".md,text/markdown,image/*" onChange={(e) => fromInput(e.currentTarget, "Files")} />
        <p className="muted small">Or drop Markdown files here.</p>
        <button className="quiet" onClick={() => openHelp("standalone")}>
          <Icon name="help" size={16} /> How it works
        </button>
      </div>
      <HelpHost />
      <Overlays />
    </div>
  );
}

// ── file panel ────────────────────────────────────────────────────────────────────────

interface Tree {
  name: string;
  path: string;
  folders: Map<string, Tree>;
  notes: NoteSummary[];
}
function buildTree(notes: NoteSummary[]): Tree {
  const root: Tree = { name: "", path: "", folders: new Map(), notes: [] };
  for (const n of notes) {
    const parts = n.path.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) {
      let next = node.folders.get(p);
      if (!next) node.folders.set(p, (next = { name: p, path: node.path ? `${node.path}/${p}` : p, folders: new Map(), notes: [] }));
      node = next;
    }
    node.notes.push(n);
  }
  return root;
}

function Sidebar(p: {
  notes: NoteSummary[];
  activeId: number | null;
  tab: "files" | "search" | "tags";
  setTab: (t: "files" | "search" | "tags") => void;
  query: string;
  setQuery: (q: string) => void;
  onOpen: (n: NoteSummary) => void;
  onNewNote: (folder?: string) => void;
  onSwitch: () => void;
}) {
  const tree = useMemo(() => buildTree(p.notes), [p.notes]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  // Typing doesn't change the note list, so the footer follows the save status on its own.
  useSyncExternalStore(vault.subscribeStatus, vault.statusVersion);
  const dirty = vault.dirtyCount();
  const writes = vault.canWrite();

  // The open note's folders open with it.
  useEffect(() => {
    const n = p.notes.find((x) => x.id === p.activeId);
    if (!n) return;
    const parts = n.path.split("/").slice(0, -1);
    setOpenFolders((s) => {
      const next = new Set(s);
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")));
      return next.size === s.size ? s : next;
    });
  }, [p.activeId]);

  const toggle = (path: string) =>
    setOpenFolders((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  function render(node: Tree, depth: number): React.ReactNode {
    return (
      <>
        {[...node.folders.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => {
            const isOpen = openFolders.has(f.path);
            return (
              <li key={"d:" + f.path}>
                <div className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(f.path)}>
                  <button type="button" className="tree-toggle" aria-expanded={isOpen}>
                    <span className={`chev${isOpen ? " open" : ""}`} aria-hidden="true">
                      <Icon name="chevron" size={14} />
                    </span>
                    <span className="tree-label">{f.name}</span>
                  </button>
                  <span className="row-actions">
                    <button className="row-btn" title="New note here" aria-label={`New note in ${f.name}`} onClick={(e) => (e.stopPropagation(), p.onNewNote(f.path))}>
                      <Icon name="plus" size={15} />
                    </button>
                  </span>
                </div>
                {isOpen && <ul>{render(f, depth + 1)}</ul>}
              </li>
            );
          })}
        {[...node.notes]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((n) => (
            <li key={n.id}>
              <a className={`tree-row note${n.id === p.activeId ? " active" : ""}`} style={{ paddingLeft: 8 + depth * 14 + 18 }} href="#" onClick={(e) => (e.preventDefault(), p.onOpen(n))}>
                <span className="tree-label">{n.title}</span>
              </a>
            </li>
          ))}
      </>
    );
  }

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of p.notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [p.notes]);

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(vault.changesZip());
    a.download = `${vault.vaultName()} changes.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    vault.markAllSaved();
    toast("Saved the changed notes as a zip. Unzip it over the folder to keep them.");
  }

  return (
    <nav className="sidebar">
      <div className="vault-switch standalone-vault">
        <span className="standalone-vault-name" title={vault.vaultName()}>
          <Icon name="folder" size={16} /> {vault.vaultName()}
        </span>
        <button className="icon-btn" onClick={() => openHelp()} title="Help" aria-label="Help">
          <Icon name="help" />
        </button>
        <button className="icon-btn" onClick={p.onSwitch} title="Open another folder" aria-label="Open another folder">
          <Icon name="vault" />
        </button>
      </div>
      <div className="sidebar-actions">
        <button onClick={() => p.onNewNote()}>
          <Icon name="plus" size={16} /> New note
        </button>
      </div>
      <div className="tabs">
        {(["files", "search", "tags"] as const).map((t) => (
          <button key={t} className={p.tab === t ? "on" : ""} onClick={() => p.setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="sidebar-scroll">
        {p.tab === "files" && (p.notes.length ? <ul className="tree">{render(tree, 0)}</ul> : <div className="muted pad">No notes yet. Make one with New note.</div>)}
        {p.tab === "search" && <Search notes={p.notes} query={p.query} setQuery={p.setQuery} onOpen={p.onOpen} />}
        {p.tab === "tags" && (
          <ul className="tag-list">
            {tags.length === 0 && <li className="muted pad">No tags yet. Add #tags in notes or tags: in frontmatter.</li>}
            {tags.map(([t, n]) => (
              <li key={t}>
                <button onClick={() => (p.setQuery(`#${t}`), p.setTab("search"))}>
                  #{t} <span className="count">{n}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-foot standalone-foot">
        {writes ? (
          <span className="muted small" role="status">
            {dirty ? "Saving…" : "Saved to the folder"}
          </span>
        ) : (
          <>
            <span className="muted small" role="status">
              {dirty ? `${dirty} changed, not saved` : "No unsaved changes"}
            </span>
            <button disabled={!dirty} onClick={download} title="Download the changed notes as a zip">
              <Icon name="download" size={16} /> Download changes
            </button>
          </>
        )}
      </div>
    </nav>
  );
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Every word must appear (a #tag must be one of the note's tags); title matches first. */
function Search(p: { notes: NoteSummary[]; query: string; setQuery: (q: string) => void; onOpen: (n: NoteSummary) => void }) {
  // Typing in the box stays quick: the search over every note runs behind it.
  const query = useDeferredValue(p.query);
  const hits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out: { n: NoteSummary; score: number; snippet: string }[] = [];
    for (const n of p.notes) {
      const lower = vault.lowerOf(n.id);
      const title = n.title.toLowerCase();
      if (!words.every((w) => (w.startsWith("#") ? n.tags.includes(w.slice(1)) : lower.includes(w) || title.includes(w)))) continue;
      const first = words.find((w) => !w.startsWith("#"));
      const at = first ? lower.indexOf(first) : -1;
      let snippet = "";
      if (at >= 0) {
        const start = Math.max(0, at - 40);
        const raw = (vault.getNote(n.id)?.content ?? "").slice(start, at + 80).replace(/\s+/g, " ");
        snippet = (start ? "…" : "") + escHtml(raw).replace(new RegExp(first!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
      }
      out.push({ n, score: words.filter((w) => title.includes(w)).length, snippet });
    }
    return out.sort((a, b) => b.score - a.score || b.n.updated_at.localeCompare(a.n.updated_at)).slice(0, 100);
  }, [query, p.notes]);

  return (
    <div className="search-panel">
      <input autoFocus type="search" placeholder="Search notes" aria-label="Search notes" value={p.query} onChange={(e) => p.setQuery(e.target.value)} />
      {p.query.trim() && <div className="search-meta muted">{hits.length === 0 ? "No notes match." : `${hits.length} note${hits.length === 1 ? "" : "s"}`}</div>}
      <ul className="search-results">
        {hits.map(({ n, snippet }) => (
          <li key={n.id}>
            <a href="#" onClick={(e) => (e.preventDefault(), p.onOpen(n))}>
              <div className="hit-title">{n.title}</div>
              {n.path.includes("/") && <div className="hit-path">{n.path.replace(/\/[^/]+$/, "")}</div>}
              {snippet && <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: snippet }} />}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the note ──────────────────────────────────────────────────────────────────────────

function NoteScreen(p: {
  note: NoteSummary;
  notes: NoteSummary[];
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenLink: (target: string) => void;
  onOpen: (n: NoteSummary) => void;
  onTag: (tag: string) => void;
  onDeleted: () => void;
}) {
  const [saved, setMode] = useState<Mode>(() => (store.get("mode") as Mode) || "edit");
  // A phone has room for one pane: split shows as editing.
  const isNarrow = narrow();
  const mode: Mode = isNarrow && saved === "split" ? "edit" : saved;
  const [text, setText] = useState(() => vault.getNote(p.note.id)?.content ?? "");
  const [renaming, setRenaming] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const preview = useRef<HTMLDivElement>(null);
  const notesRef = useRef(p.notes);
  notesRef.current = p.notes;

  const setModeSaved = (m: Mode) => (setMode(m), store.set("mode", m));
  const folder = p.note.path.includes("/") ? p.note.path.replace(/\/[^/]+$/, "") : "";
  const showPreview = mode === "split" || mode === "read";
  // The preview follows the text a moment behind, so a long note doesn't slow typing.
  const shown = useDeferredValue(text);
  const html = useMemo(() => (showPreview ? renderMarkdown(shown, vault.VAULT_ID, p.notes) : ""), [showPreview, shown, p.notes]);

  useEffect(() => {
    if (preview.current) hydrate(preview.current, { vaultId: vault.VAULT_ID, notes: p.notes, ancestors: [p.note.id], onOpen: p.onOpenLink });
  }, [html]);

  // Dataview results follow the folder: again a moment after typing, or when notes change.
  useEffect(() => {
    const t = setTimeout(refreshDataview, 600);
    return () => clearTimeout(t);
  }, [text, p.notes]);
  // A task ticked in a Dataview result may be in this note: start the editor from the new text.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== p.note.id) return;
      setText(vault.getNote(p.note.id)?.content ?? "");
      setEditorKey((k) => k + 1);
    };
    window.addEventListener("cp-note-replaced", on);
    return () => window.removeEventListener("cp-note-replaced", on);
  }, [p.note.id]);

  function onChange(t: string) {
    setText(t);
    vault.setContent(p.note.id, t);
  }

  function onPreviewClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.dataset.task) {
      e.preventDefault();
      const next = toggleTask(text, Number(el.dataset.task));
      if (next !== null) {
        onChange(next);
        // The editor holds its own copy: start it again from the new text.
        setEditorKey((k) => k + 1);
      }
      return;
    }
    const a = el.closest("a");
    if (!a) return;
    if (a.dataset.target) (e.preventDefault(), p.onOpenLink(a.dataset.target));
    else if (a.dataset.tag) (e.preventDefault(), p.onTag(a.dataset.tag));
  }
  const [editorKey, setEditorKey] = useState(0);

  async function rename(title: string) {
    setRenaming(false);
    const t = title.trim();
    if (!t || t === p.note.title) return;
    if (t.includes("/")) return toast("A title can't contain /.", { tone: "error" });
    try {
      await vault.renameNote(p.note.id, folder ? `${folder}/${t}` : t);
    } catch (e) {
      toastError(e);
    }
  }

  async function move() {
    const to = await promptDialog({
      title: "Move note",
      message: "Its path in the folder, with any subfolders: Projects/Plan",
      label: "Path",
      value: p.note.path.replace(/\.md$/i, ""),
      action: "Move",
    });
    if (!to) return;
    try {
      await vault.renameNote(p.note.id, to);
    } catch (e) {
      toastError(e);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${p.note.title}?`,
      message: vault.canWrite() ? "The file is deleted from the folder. This can't be undone here." : "It's removed from this tab.",
      action: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await vault.deleteNote(p.note.id);
      p.onDeleted();
    } catch (e) {
      toastError(e);
    }
  }

  const outline = useMemo(() => headings(text), [text]);
  const outgoing = useMemo(
    () => [
      ...new Map(
        findWikiLinks(text)
          .filter((l) => !isAttachmentPath(l.target.split("#")[0]!))
          .map((l) => [l.target.split("#")[0]!.toLowerCase(), l.target.split("#")[0]!]),
      ).values(),
    ],
    [text],
  );
  const backlinks = useMemo(
    () =>
      p.notes.filter((n) => {
        if (n.id === p.note.id) return false;
        return vault.linksOf(n.id).some((t) => resolveLocal(p.notes, t)?.id === p.note.id);
      }),
    [p.notes, p.note.id],
  );

  return (
    <>
      <main className="main">
        <div className={`note-view mode-${mode}`}>
          <header className="note-header">
            <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
            <div className="note-title-wrap">
              <div className="breadcrumb">{folder && <span>{folder.split("/").join(" / ")}</span>}</div>
              {renaming ? (
                <input
                  className="title-input"
                  autoFocus
                  defaultValue={p.note.title}
                  onBlur={(e) => void rename(e.currentTarget.value)}
                  aria-label="Note title"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.preventDefault(), e.currentTarget.blur());
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
              ) : (
                <h1 className="note-title">
                  <button type="button" className="title-button" onClick={() => setRenaming(true)} title="Rename" aria-label={`Rename “${p.note.title}”`}>
                    {p.note.title}
                  </button>
                </h1>
              )}
            </div>
            <div className="note-actions">
              {isNarrow ? (
                <button
                  className="icon-btn"
                  onClick={() => setModeSaved(mode === "read" ? "edit" : "read")}
                  aria-label={mode === "read" ? "Edit" : "Reading view"}
                  title={mode === "read" ? "Edit" : "Reading view"}
                >
                  <Icon name={mode === "read" ? "edit" : "book"} />
                </button>
              ) : (
                <div className="segmented" role="radiogroup" aria-label="View">
                  {(
                    [
                      ["edit", "edit", "Live preview"],
                      ["source", "code", "Source mode"],
                      ["split", "split", "Edit and preview"],
                      ["read", "book", "Reading view"],
                    ] as const
                  ).map(([m, icon, label]) => (
                    <button key={m} role="radio" aria-checked={mode === m} aria-label={label} title={label} className={mode === m ? "on" : ""} onClick={() => setModeSaved(m)}>
                      <Icon name={icon} />
                    </button>
                  ))}
                </div>
              )}
              <Menu
                label="More"
                items={[
                  ...(isNarrow
                    ? [{ label: mode === "source" ? "Live preview" : "Source mode", icon: mode === "source" ? "edit" : "code", onSelect: () => setModeSaved(mode === "source" ? "edit" : "source") }]
                    : []),
                  { label: "Rename", icon: "edit", onSelect: () => setRenaming(true) },
                  { label: "Move to…", icon: "folder", onSelect: () => void move() },
                  { label: "Delete", icon: "trash", danger: true, onSelect: () => void remove() },
                ]}
              />
              <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
            </div>
          </header>
          <div className="note-body">
            <div className="pane edit-pane" hidden={mode === "read"}>
              <Editor
                key={editorKey}
                ref={editor}
                noteId={p.note.id}
                initial={vault.getNote(p.note.id)?.content ?? ""}
                livePreview={mode === "edit"}
                notes={() => notesRef.current}
                onChange={onChange}
                onOpenLink={p.onOpenLink}
              />
            </div>
            {showPreview && <div className="pane preview markdown" ref={preview} onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />}
          </div>
        </div>
      </main>
      <aside className="right-panel" aria-label="Links and outline">
        <div className="links-panel">
          <section>
            <h3>Outline</h3>
            {outline.length === 0 ? (
              <p className="muted">No headings.</p>
            ) : (
              <ul className="outline">
                {outline.map((h, i) => (
                  <li key={i} style={{ paddingLeft: (h.level - Math.min(...outline.map((x) => x.level))) * 12 }}>
                    <button onClick={() => (mode === "read" && setModeSaved("edit"), setTimeout(() => editor.current?.jumpToLine(h.line)))}>{h.text}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>
              Backlinks <span className="count">{backlinks.length}</span>
            </h3>
            {backlinks.length === 0 && <p className="muted">Nothing links here yet.</p>}
            <ul className="link-list">
              {backlinks.map((n) => (
                <li key={n.id}>
                  <button onClick={() => p.onOpen(n)}>{n.title}</button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>
              Outgoing links <span className="count">{outgoing.length}</span>
            </h3>
            <ul className="link-list">
              {outgoing.map((t) => {
                const hit = resolveLocal(p.notes, t);
                return (
                  <li key={t}>
                    <button className={hit ? "" : "unresolved"} onClick={() => p.onOpenLink(t)} title={hit ? undefined : "Not created yet — click to create"}>
                      {hit?.title ?? t}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}

// ── attachments ───────────────────────────────────────────────────────────────────────

const SERVED = `/api/vaults/${vault.VAULT_ID}/files?path=`;

/** The shared renderer points images at the server's file route; point them at the folder's
 *  files instead, wherever they appear (preview, Live Preview widgets, embeds). */
function useAttachmentUrls() {
  useEffect(() => {
    const fix = (el: Element) => {
      for (const attr of ["src", "href"]) {
        const v = el.getAttribute(attr);
        if (!v?.startsWith(SERVED)) continue;
        const path = decodeURIComponent(v.slice(SERVED.length));
        el.setAttribute(attr, "");
        void vault.attachmentUrl(path).then((url) => {
          if (url) el.setAttribute(attr, url);
          else if (el instanceof HTMLImageElement) el.alt = `${path} isn't in this folder`;
        });
      }
    };
    const scan = (root: ParentNode) => root.querySelectorAll(`[src^="${SERVED}"], [href^="${SERVED}"]`).forEach(fix);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") fix(r.target as Element);
        else
          r.addedNodes.forEach((n) => {
            if (!(n instanceof Element)) return;
            fix(n);
            scan(n);
          });
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
    scan(document.body);
    return () => mo.disconnect();
  }, []);
}
