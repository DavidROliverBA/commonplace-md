// One open note: the header (type chip, title to rename, peers, connection, view mode, ⋯ menu),
// the editor and/or the rendered preview, the phone's formatting bar, the `@name` AI box and the
// history dialog. The text lives in a Yjs doc synced over /ws (y-websocket) and kept on this
// device in IndexedDB (F4), so it opens and takes edits offline; only metadata comes over REST.
// What the note can do is published to web/lib/commands.ts with provide("note", …).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import { offlineName, rememberOpened } from "../lib/offline";
import * as Y from "yjs";
import { headings, normalisePath } from "../../src/markdown";
import { api, type Note, type NoteSummary, type User } from "../lib/api";
import { userColor } from "../lib/links";
import { renderMarkdown, toggleTask } from "../lib/render";
import { type Assistant, asCallout, Conversation, loadAssistants } from "../lib/ai";
import { AiChat } from "./AiChat";
import { hydrate } from "../lib/embeds";
import { isBookmarked, toggleBookmark, useBookmarks } from "../lib/bookmarks";
import { preferredAssistant, rememberAssistant } from "./AiPanel";
import { editAssistant } from "./AssistantDialog";
import { Editor, type EditorHandle } from "./Editor";
import { TypeEditor } from "./TypeEditor";
import { isTypePath } from "../../src/types";
import { History } from "./History";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { setFocusMode, useFocusMode } from "../lib/focusMode";
import { useNarrow } from "../lib/useNarrow";
import { navigate, noteUrl } from "../lib/router";
import { moveToPicker } from "../lib/moving";
import { pickTemplate } from "../lib/templateActions";
import { addDays, dailyDate, fillTemplate, formatDate } from "../lib/templates";
import { COMMANDS, currentCtx, type NoteActions, noteMenu, provide } from "../lib/commands";
import { Menu } from "../ui/Menu";
import { createTypedNote, setProperties, typeNamed, typesState, typeUrl, useTypes } from "../lib/types";
import { chooseDialog, toast, toastError } from "../ui/overlays";

/** edit = Live Preview (renders in place); source = plain markdown; read = rendered
 *  only; split = source beside the rendered view (not on a phone). */
export type Mode = "edit" | "source" | "read" | "split";

interface Props {
  vaultId: number;
  noteId: number;
  user: User;
  /** The server database's identity, for naming this note's offline copy (F4). */
  instance: string;
  notes: NoteSummary[];
  tags: string[];
  /** Every folder, for Move to…. */
  folders: string[];
  onMoved: () => void;
  onOpenLink: (target: string, sourcePath: string) => void;
  onTag: (tag: string) => void;
  onDeleted: () => void;
  onOutline: (h: { level: number; text: string; line: number }[], jump: (line: number) => void) => void;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleRight: () => void;
  onToggleLeft: () => void;
  /** Open (or make) the daily note for a day. */
  onDaily: (d: Date) => void;
}

interface Peer {
  clientId: number;
  name: string;
  color: string;
}

export function NoteView(props: Props) {
  const { vaultId, noteId, user } = props;
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [text, setText] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("cp:mode") as Mode) || "edit");
  const [renaming, setRenaming] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  const titleFocus = useRef(false);
  useEffect(() => {
    if (renaming || !titleFocus.current) return;
    titleFocus.current = false;
    titleButton.current?.focus();
  }, [renaming]);
  const [history, setHistory] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // The `@name` chat box: its conversation, and the line it belongs to (a Yjs position, so it
  // stays put as anyone edits around it).
  const [inline, setInline] = useState<{ conv: Conversation; at: Y.RelativePosition } | null>(null);
  const [inlineHost] = useState(() => {
    const el = document.createElement("div");
    el.className = "ai-inline-host";
    return el;
  });

  const readOnly = note?.role === "viewer";
  useBookmarks(); // the ⋯ menu says Bookmark or Remove bookmark
  const narrow = useNarrow();
  const focusMode = useFocusMode();
  const effectiveMode: Mode = narrow && mode === "split" ? "edit" : readOnly && mode !== "read" ? "read" : mode;

  // Opened from the keyboard (the quick switcher, a command), focus has nowhere to be: put it in
  // the text, so typing just works. Not on the phone, where focus raises the keyboard, and never
  // taken from somewhere the person chose.
  useEffect(() => {
    if (!synced || narrow || readOnly || effectiveMode === "read") return;
    const t = requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!at || at === document.body) editor.current?.focusBody();
    });
    return () => cancelAnimationFrame(t);
  }, [synced, noteId, text !== ""]);

  // Note metadata (path, role) over REST; the text itself arrives over the live socket.
  useEffect(() => {
    setNote(null);
    setError(null);
    api<Note>(`/vaults/${vaultId}/notes/${noteId}`)
      .then(setNote)
      .catch((e) => setError(e.message));
  }, [vaultId, noteId]);

  // Keep path/title in step with renames made elsewhere.
  const summary = props.notes.find((n) => n.id === noteId);
  useEffect(() => {
    if (summary && note && summary.path !== note.path) setNote({ ...note, path: summary.path, title: summary.title });
  }, [summary?.path]);

  const { ydoc, ytext, provider, local } = useMemo(() => {
    const ydoc = new Y.Doc();
    // Offline (F4): the note's CRDT state is kept on this device too, so it opens and takes edits
    // with no signal, and merges them when the socket reconnects. Same document, so no duplicates.
    const name = offlineName(props.instance, user.id, noteId);
    const local = new IndexeddbPersistence(name, ydoc);
    rememberOpened(name);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const provider = new WebsocketProvider(`${proto}//${location.host}/ws`, String(noteId), ydoc, { connect: true, maxBackoffTime: 5000 });
    const { color, light } = userColor(user.id);
    provider.awareness.setLocalStateField("user", { name: user.name, color, colorLight: light, id: user.id });
    return { ydoc, ytext: ydoc.getText("content"), provider, local };
  }, [noteId, user.id]);

  // Ready to edit from the copy on this device once it has loaded, before (or without) the server.
  const [localReady, setLocalReady] = useState(false);
  useEffect(() => {
    setLocalReady(false);
    let live = true;
    void local.whenSynced.then(() => {
      if (!live) return;
      const hasCopy = ydoc.store.clients.size > 0;
      setLocalReady(hasCopy);
      if (!hasCopy && !navigator.onLine) setError("You're offline, and this note hasn't been opened on this device yet, so there's no copy of it here.");
    });
    return () => {
      live = false;
      void local.destroy();
    };
  }, [local]);

  useEffect(() => {
    setSynced(false);
    setText(ytext.toString());
    const onSync = (s: boolean) => s && setSynced(true);
    const onStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => setStatus(status);
    const onClose = (e: CloseEvent | null) => {
      // 44xx = the server refused us (note deleted, access removed): stop retrying.
      if (e && e.code >= 4400 && e.code < 4500) {
        provider.shouldConnect = false;
        if (e.code === 4404 || e.reason === "note deleted") setError("This note was moved to Trash.");
        else {
          // Role changed: refetch and reconnect with the new permissions.
          api<Note>(`/vaults/${vaultId}/notes/${noteId}`)
            .then((n) => {
              setNote(n);
              provider.connect();
            })
            .catch((err) => setError(err.message));
        }
      }
    };
    const observe = () => setText(ytext.toString());
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((s, clientId) => {
        if (clientId !== ydoc.clientID && s.user) list.push({ clientId, name: s.user.name, color: s.user.color });
      });
      setPeers(list);
    };
    provider.on("sync", onSync);
    provider.on("status", onStatus);
    provider.on("connection-close", onClose as any);
    provider.awareness.on("change", onAwareness);
    ytext.observe(observe);
    return () => {
      ytext.unobserve(observe);
      provider.awareness.off("change", onAwareness);
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider]);

  // Outline for the side panel.
  const outline = useMemo(() => headings(text), [text]);
  useEffect(() => {
    props.onOutline(outline, (line) => {
      if (effectiveMode === "read") {
        const idx = outline.findIndex((h) => h.line === line);
        previewRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6")[idx]?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else editor.current?.jumpToLine(line);
    });
  }, [outline, effectiveMode]);

  const html = useMemo(() => {
    if (effectiveMode === "edit" || effectiveMode === "source") return "";
    try {
      return renderMarkdown(text, vaultId, props.notes);
    } catch (err) {
      // Never let one odd note take the app down: show its source instead.
      console.error("render failed:", err);
      const esc = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
      return `<p class="muted">This note couldn't be rendered; showing its source.</p><pre>${esc}</pre>`;
    }
  }, [text, effectiveMode, props.notes]);

  // Embedded notes and link cards in reading view (F2): filled in after each render.
  useEffect(() => {
    if (previewRef.current) hydrate(previewRef.current, { vaultId, notes: props.notes, ancestors: [noteId], onOpen: (t) => props.onOpenLink(t, note?.path ?? "") });
  }, [html]);

  function onPreviewClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    const link = el.closest("a.internal-link") as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      props.onOpenLink(link.dataset.target!, note?.path ?? "");
      return;
    }
    const tag = el.closest("a.tag") as HTMLAnchorElement | null;
    if (tag) {
      e.preventDefault();
      props.onTag(tag.dataset.tag!);
      return;
    }
    if (el instanceof HTMLInputElement && el.classList.contains("task")) {
      if (readOnly) {
        e.preventDefault();
        return;
      }
      const next = toggleTask(ytext.toString(), Number(el.dataset.task));
      if (next !== null) ydoc.transact(() => applyMinimal(ytext, next));
    }
  }

  async function rename(newTitle: string) {
    setRenaming(false);
    if (!note || !newTitle.trim() || newTitle.trim() === note.title) return;
    const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/") + 1) : "";
    try {
      const updated = await api<Note>(`/vaults/${vaultId}/notes/${noteId}`, { method: "PATCH", body: { path: normalisePath(folder + newTitle.trim()) } });
      setNote({ ...note, path: updated.path, title: updated.title });
    } catch (e) {
      toastError(e);
    }
  }

  // Trash keeps the note and its history for 30 days, so no "Are you sure?": do it, offer Undo.
  async function remove() {
    if (!note) return;
    try {
      const { trashId } = await api<{ trashId: number }>(`/vaults/${vaultId}/notes/${noteId}`, { method: "DELETE" });
      props.onDeleted();
      toast(`Moved “${note.title}” to Trash`, {
        undo: async () => {
          const restored = await api<Note>(`/vaults/${vaultId}/trash/${trashId}/restore`, { method: "POST" });
          navigate(noteUrl(vaultId, restored.id));
        },
      });
    } catch (e) {
      toastError(e);
    }
  }

  function setModeSaved(m: Mode) {
    setMode(m);
    localStorage.setItem("cp:mode", m);
  }

  async function askHere(a?: Assistant) {
    if (readOnly) return;
    let pick = a;
    if (!pick) {
      try {
        pick = preferredAssistant(await loadAssistants());
      } catch (e) {
        return toastError(e);
      }
    }
    pick ??= (await editAssistant()) ?? undefined;
    if (!pick) return;
    rememberAssistant(pick);
    inline?.conv.stop();
    const at = Y.createRelativePositionFromTypeIndex(ytext, editor.current?.cursor() ?? ytext.length);
    setInline({ conv: new Conversation(pick, () => ({ vaultId, noteId })), at });
  }

  const inlineIndex = () => (inline ? (Y.createAbsolutePositionFromRelativePosition(inline.at, ydoc)?.index ?? ytext.length) : 0);

  // ✓ puts the conversation into the note as a folded callout: on its line if that's empty,
  // else just below it.
  function keepInline() {
    if (!inline || inline.conv.empty) return;
    const text = ytext.toString();
    const at = Math.min(inlineIndex(), text.length);
    const start = text.lastIndexOf("\n", at - 1) + 1;
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    const callout = asCallout(inline.conv, user.name, formatDate(new Date(), "YYYY-MM-DD"));
    ydoc.transact(() => {
      if (!text.slice(start, end).trim()) ytext.insert(start, callout);
      else ytext.insert(end, "\n" + callout.replace(/\n$/, ""));
    });
    closeInline();
    toast("Kept the conversation in the note");
  }
  function closeInline() {
    inline?.conv.stop();
    setInline(null);
    editor.current?.focus();
  }

  useEffect(() => {
    if (!inline || narrow) editor.current?.showInline(null);
    else editor.current?.showInline(inlineIndex(), inlineHost);
    // React mounted the box before CodeMirror placed it in the page, so focus it now.
    if (inline) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".ai-inline-host textarea, .ai-sheet textarea")?.focus());
  }, [inline, narrow]);
  useEffect(() => () => inline?.conv.stop(), [inline]);

  // A line in a daily note becomes a Person, a Task or a Project, with a link left behind
  // (from Capacities). The text is the new note's title; an existing note of that name is
  // linked instead of made twice.
  async function makeTyped() {
    const at = editor.current?.selectedOrLine();
    if (!at) return toast("Select some text, or put the cursor on a line, to make it a note");
    const title = at.text.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1").replace(/[*_`~=]/g, "").replace(/[\\/:]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return;
    const types = typesState().types;
    const choice = await chooseDialog({ title: `Make “${title}” a…`, options: types.map((t) => ({ value: t.name, label: t.name, icon: t.icon })), placeholder: "Which type?" });
    if (choice === null) return;
    const type = types.find((t) => t.name === choice)!;
    const existing = props.notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    try {
      const made = existing ? null : await createTypedNote(vaultId, type, title);
      editor.current?.replaceRange(at.from, at.to, `[[${existing?.title ?? title}]]`);
      const id = made?.id ?? existing!.id;
      toast(made ? `Made ${type.name} “${title}”` : `Linked to the note “${existing!.title}” that was already there`, { action: { label: "Open", run: () => navigate(noteUrl(vaultId, id)) } });
    } catch (e) {
      toastError(e);
    }
  }

  // What this note can do, for the ⋯ menu, the ⌘K palette and the editor's / menu. Published
  // after each render, and withdrawn on unmount only if it's still this note's.
  const actions: NoteActions = {
    readOnly,
    mode: effectiveMode,
    narrow,
    makeTyped: () => void makeTyped(),
    get editor() {
      return editor.current;
    },
    downloadHref: `/api/vaults/${vaultId}/notes/${noteId}/export`,
    setMode: setModeSaved,
    history: () => setHistory(true),
    copyLink: () => void navigator.clipboard?.writeText(`[[${note?.title}]]`).then(() => toast("Wikilink copied"), toastError),
    rename: () => setRenaming(true),
    moveTo: () => note && void moveToPicker(vaultId, { kind: "note", id: noteId, path: note.path }, props.folders, props.onMoved),
    trash: () => void remove(),
    pickPicture: () => picker.current?.click(),
    insertTemplate: () => void insertTemplate(),
    askHere: (a) => void askHere(a),
    bookmark: () => note && void toggleBookmark(vaultId, noteId, note.title),
    bookmarked: isBookmarked(noteId),
  };
  useEffect(() => {
    provide("note", actions);
    return () => {
      if (currentCtx().note === actions) provide("note", null);
    };
  });

  if (error)
    return (
      <div className="empty-state">
        <p>{error}</p>
      </div>
    );

  const folder = note?.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
  const day = note ? dailyDate(note.path) : null;

  async function insertTemplate() {
    try {
      const picked = await pickTemplate(vaultId, props.notes);
      if (picked) editor.current?.insertTemplate(fillTemplate(picked.text, { title: note?.title ?? "", date: new Date() }));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className={`note-view mode-${effectiveMode}`}>
      <header className="note-header">
        <PanelToggle side="left" open={props.leftOpen} onToggle={props.onToggleLeft} />
        <div className="note-title-wrap">
          <div className="breadcrumb">
            {(summary?.path ?? note?.path) && !isTypePath(summary?.path ?? note!.path) && <TypeChip vaultId={vaultId} noteId={noteId} type={summary ? (summary.type ?? null) : (note?.type ?? null)} readOnly={readOnly} />}
            {folder && <span>{folder.split("/").join(" / ")}</span>}
          </div>
          {renaming && !readOnly ? (
            <input
              className="title-input"
              autoFocus
              defaultValue={note?.title}
              onBlur={(e) => rename(e.currentTarget.value)}
              aria-label="Note title"
              onKeyDown={(e) => {
                // Finished from the keyboard: focus goes back to the title, not to the page.
                if (e.key === "Enter" || e.key === "Escape") titleFocus.current = true;
                // preventDefault: no keypress follows to "click" the title button focus returns to.
                if (e.key === "Enter") (e.preventDefault(), e.currentTarget.blur());
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : readOnly ? (
            <h1 className="note-title" title={note?.path}>
              {note?.title ?? "…"}
            </h1>
          ) : (
            // A button inside the heading: the title is still the page's heading, and Tab, Enter or
            // a click renames it.
            <h1 className="note-title">
              <button ref={titleButton} type="button" className="title-button" onClick={() => setRenaming(true)} title="Rename" aria-label={`Rename “${note?.title ?? ""}”`}>
                {note?.title ?? "…"}
              </button>
            </h1>
          )}
        </div>
        <div className="note-actions">
          {focusMode && (
            <button className="quiet focus-exit" onClick={() => setFocusMode(false)} title="Leave focus mode (Esc)">
              Leave focus
            </button>
          )}
          {day && (
            <div className="day-nav">
              <button className="icon-btn" onClick={() => props.onDaily(addDays(day, -1))} aria-label={`Previous day, ${formatDate(addDays(day, -1), "dddd D MMMM")}`} title="Previous day">
                <Icon name="chevron-left" />
              </button>
              <button className="icon-btn" onClick={() => props.onDaily(addDays(day, 1))} aria-label={`Next day, ${formatDate(addDays(day, 1), "dddd D MMMM")}`} title="Next day">
                <Icon name="chevron" />
              </button>
            </div>
          )}
          <div className="peers">
            {peers.slice(0, 4).map((p) => (
              <span key={p.clientId} className="avatar" style={{ background: p.color }} title={`${p.name} is here`}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {peers.length > 4 && <span className="avatar more">+{peers.length - 4}</span>}
          </div>
          <span className={`conn conn-${status}`} title={status === "connected" ? "Live — changes save automatically" : status === "connecting" ? "Connecting…" : "Offline — edits will sync when you reconnect"} />
          {readOnly && <span className="badge">Read only</span>}
          {!readOnly && (
            narrow ? (
              // On a phone, one toggle keeps room for the title; Source mode is in the ⋯ menu.
              <button
                className="icon-btn"
                onClick={() => setModeSaved(effectiveMode === "read" ? "edit" : "read")}
                aria-label={effectiveMode === "read" ? "Edit" : "Reading view"}
                title={effectiveMode === "read" ? "Edit" : "Reading view"}
              >
                <Icon name={effectiveMode === "read" ? "edit" : "book"} />
              </button>
            ) : (
              <div className="segmented" role="radiogroup" aria-label="View">
                <button role="radio" aria-checked={effectiveMode === "edit"} aria-label="Live preview" className={effectiveMode === "edit" ? "on" : ""} onClick={() => setModeSaved("edit")} title="Live preview">
                  <Icon name="edit" />
                </button>
                <button role="radio" aria-checked={effectiveMode === "source"} aria-label="Source mode" className={effectiveMode === "source" ? "on" : ""} onClick={() => setModeSaved("source")} title="Source mode">
                  <Icon name="code" />
                </button>
                <button role="radio" aria-checked={effectiveMode === "split"} aria-label="Edit and preview" className={effectiveMode === "split" ? "on" : ""} onClick={() => setModeSaved("split")} title="Edit and preview">
                  <Icon name="split" />
                </button>
                <button role="radio" aria-checked={effectiveMode === "read"} aria-label="Reading view" className={effectiveMode === "read" ? "on" : ""} onClick={() => setModeSaved("read")} title="Reading view">
                  <Icon name="book" />
                </button>
              </div>
            )
          )}
          <Menu label="More" items={() => noteMenu().map((c) => ({ label: c.title, icon: c.icon, danger: c.danger, href: c.href?.(currentCtx()), onSelect: c.href ? undefined : () => c.run(currentCtx()) }))} />
          <PanelToggle side="right" open={props.rightOpen} onToggle={props.onToggleRight} />
        </div>
      </header>

      {note && isTypePath(note.path) && <TypeEditor vaultId={vaultId} name={note.title} readOnly={readOnly} />}
      {/* data-synced: the live socket has synced (tests wait on it instead of sleeping). */}
      <div className="note-body" data-synced={synced || undefined}>
        {!synced && !localReady && <div className="loading-bar" />}
        <div className="pane edit-pane" hidden={effectiveMode === "read"}>
          <Editor
            ref={editor}
            ytext={ytext}
            awareness={provider.awareness}
            readOnly={readOnly || !(synced || localReady)}
            livePreview={effectiveMode === "edit"}
            vaultId={vaultId}
            notes={() => props.notes}
            notesVersion={props.notes}
            tags={() => props.tags}
            onOpenLink={(target) => props.onOpenLink(target, note?.path ?? "")}
            typeNote={!!note && isTypePath(note.path)}
            noteId={noteId}
            typewriter={focusMode}
          />
        </div>
        {(effectiveMode === "split" || effectiveMode === "read") && <div className="pane preview markdown" ref={previewRef} onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />}
      </div>

      {!readOnly && effectiveMode !== "read" && (
        <div className="format-bar only-touch">
          <button onClick={() => editor.current?.insert("[[")} aria-label="Link">[[ ]]</button>
          <button onClick={() => editor.current?.insert("#")} aria-label="Tag">#</button>
          <button onClick={() => editor.current?.wrap("**")} aria-label="Bold">
            <b>B</b>
          </button>
          <button onClick={() => editor.current?.wrap("*")} aria-label="Italic">
            <i>I</i>
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => COMMANDS.find((c) => c.id === "format.colour")!.run(currentCtx())}
            aria-label="Colour"
          >
            <span className="format-colour" aria-hidden="true">A</span>
          </button>
          <button onClick={() => picker.current?.click()} aria-label="Insert picture">
            <Icon name="image" />
          </button>
          <button onClick={() => editor.current?.insertLinePrefix("- [ ] ")} aria-label="Task">
            <Icon name="check" />
          </button>
          <button onClick={() => editor.current?.insertLinePrefix("- ")} aria-label="List">
            <Icon name="list" />
          </button>
          <button onClick={() => editor.current?.insertLinePrefix("## ")} aria-label="Heading">
            H
          </button>
          <button onClick={() => editor.current?.undo()} aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button onClick={() => editor.current?.redo()} aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
      )}

      {/* iOS offers Photo Library, Take Photo or Choose File for an image/* input. */}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          editor.current?.insertFiles(files);
        }}
      />

      {inline &&
        (() => {
          const chat = (
            <AiChat
              conv={inline.conv}
              vaultId={vaultId}
              notes={props.notes}
              onOpenLink={(t) => props.onOpenLink(t, note?.path ?? "")}
              header={
                <span className="ai-inline-name">
                  <Icon name="sparkle" size={14} /> {inline.conv.assistant.name}
                </span>
              }
              onKeep={keepInline}
              keepLabel="Keep in the note"
              onDiscard={closeInline}
              placeholder={`Ask ${inline.conv.assistant.name} about this note, or anything in your vault…`}
              autoFocus
            />
          );
          // On a phone a bottom sheet, clear of the keyboard; on a laptop, under its line.
          return narrow ? <div className="ai-sheet">{chat}</div> : createPortal(chat, inlineHost);
        })()}
      {history && note && <History vaultId={vaultId} note={note} readOnly={readOnly} onClose={() => setHistory(false)} />}
    </div>
  );
}

// Replace ytext with next by editing only the span between their common prefix and suffix, so a
// ticked checkbox merges with whatever anyone else is typing.
function applyMinimal(ytext: Y.Text, next: string) {
  const cur = ytext.toString();
  let s = 0;
  while (s < cur.length && cur[s] === next[s]) s++;
  let e1 = cur.length;
  let e2 = next.length;
  while (e1 > s && e2 > s && cur[e1 - 1] === next[e2 - 1]) {
    e1--;
    e2--;
  }
  if (e1 > s) ytext.delete(s, e1 - s);
  if (e2 > s) ytext.insert(s, next.slice(s, e2));
}

/** What this note is (F16): its type's icon and name above the title. Tap it to open the type's
 *  page or change the type; an untyped note shows "Add a type" on hover. Changing type keeps every
 *  property, so nothing is lost. */
function TypeChip({ vaultId, noteId, type, readOnly }: { vaultId: number; noteId: number; type: string | null; readOnly: boolean }) {
  const { types } = useTypes();
  const def = typeNamed(type);
  if (!type && (readOnly || !types.length)) return null;
  const change = (to: string | null) => setProperties(vaultId, noteId, { type: to }).then(() => toast(to ? `Now a ${to}` : "No longer typed"), toastError);
  return (
    <Menu
      label={type ? `Type: ${type}` : "Add a type"}
      className={`type-chip colour-${def?.colour ?? "grey"}${type ? "" : " empty"}`}
      trigger={
        <>
          <Icon name={def?.icon ?? "shapes"} size={14} /> {type ?? "Add a type"}
        </>
      }
      items={() => [
        ...(type ? [{ label: `All ${type} notes`, icon: "list", onSelect: () => navigate(typeUrl(vaultId, type)) }] : []),
        ...(readOnly
          ? []
          : [
              ...types.filter((t) => t.name !== type).map((t) => ({ label: type ? `Make it a ${t.name}` : t.name, icon: t.icon, onSelect: () => void change(t.name) })),
              ...(type ? [{ label: "Remove the type", icon: "x", onSelect: () => void change(null) }] : []),
            ]),
      ]}
    />
  );
}
