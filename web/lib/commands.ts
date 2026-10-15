// Every action in one list (docs/PRINCIPLES.md §1–2). The ⌘K palette shows all that apply, the
// note's ⋯ menu shows those marked `noteMenu`, and the editor's `/` menu those marked `slash`,
// so an action is named, iconed and behaves the same wherever it's found.
//
// Screens publish what they can do with provide(): App the app-wide actions, the sidebar its
// own, an open note its actions and editor. It's module state, so CodeMirror (outside React)
// can read it too.

import type { EditorHandle } from "../components/Editor";
import type { Assistant } from "./ai";
import type { Mode } from "../components/NoteView";
import { formatDate } from "./templates";
import { chooseDialog } from "../ui/overlays";
import { PALETTE } from "./colours";
import { openSettings } from "./settings";
import { focusModeOn, setFocusMode } from "./focusMode";
import { typesState } from "./types";

/** Colour the selection (F10): pick a text colour, a highlight, or none. */
async function pickColour(e: EditorHandle) {
  const choice = await chooseDialog({
    title: "Colour",
    options: [
      ...PALETTE.map((p) => ({ value: `highlight:${p.name}`, label: `${p.label} highlight`, swatch: `hl-${p.name}` })),
      ...PALETTE.map((p) => ({ value: `text:${p.name}`, label: `${p.label} text`, swatch: `tc-${p.name}` })),
      { value: "none", label: "Remove colour", icon: "x" },
    ],
    placeholder: "Red, yellow highlight, none…",
  });
  if (!choice) return;
  if (choice === "none") return e.colour("text", null);
  const [kind, name] = choice.split(":") as ["text" | "highlight", any];
  e.colour(kind, name);
}

export interface AppActions {
  canWrite: boolean;
  findNote(): void;
  search(): void;
  graph(): void;
  /** Every task in the vault. */
  tasks(): void;
  home(): void;
  today(): void;
  newNote(): void;
  newFromTemplate(): void;
  /** F16: a note of a type (asks which, then the title), and a new type. */
  newTyped(type?: string): void;
  newType(): void;
  /** Save a web page as a Weblink note. */
  saveLink(): void;
  isAdmin: boolean;
  trash(): void;
  toggleLeft(): void;
  toggleRight(): void;
  /** Open a note by path or title; its title, or null if there's no such note. */
  openNote(target: string): string | null;
  /** The AI side panel (⌘J). */
  askAi(): void;
  /** /boyai: add an assistant. */
  addAssistant(): void;
  exportHref: string;
  /** New vault from GitHub (F14). */
  newGitVault(): void;
  /** On a GitHub vault: its branch. */
  git: GitActions | null;
}
export interface GitActions {
  pushed: boolean;
  hasPr: boolean;
  changes: number;
  unpushed: number;
  review(): void;
  pullRequest(): void;
  update(): void;
  cancel(): void;
}
export interface SidebarActions {
  newFolder(): void;
}
export interface NoteActions {
  readOnly: boolean;
  mode: Mode;
  narrow: boolean;
  editor: EditorHandle | null;
  downloadHref: string;
  setMode(m: Mode): void;
  history(): void;
  copyLink(): void;
  rename(): void;
  moveTo(): void;
  trash(): void;
  pickPicture(): void;
  insertTemplate(): void;
  /** Star it in the sidebar (F7), or unstar it. */
  bookmark(): void;
  bookmarked: boolean;
  /** The `@name` chat box at the cursor: with this assistant, else the last one used. */
  askHere(a?: Assistant): void;
  /** Turn the selection (or the line) into a note of a type, leaving a link in its place. */
  makeTyped(): void;
}
export interface Ctx {
  app: AppActions | null;
  sidebar: SidebarActions | null;
  note: NoteActions | null;
}

const ctx: Ctx = { app: null, sidebar: null, note: null };
/** A screen publishes what it can do now (null when it can't); commands read it at run time. */
export function provide<K extends keyof Ctx>(key: K, value: Ctx[K]): void {
  ctx[key] = value;
}
export const currentCtx = (): Ctx => ctx;

export type Group = "Insert" | "Note" | "Create" | "Go" | "View" | "Vault" | "Settings";

export interface Command {
  id: string;
  title: string;
  group: Group;
  icon?: string;
  /** More words to find it by. */
  keywords?: string;
  /** Shown beside it, e.g. ⌘O. */
  shortcut?: string;
  /** In the editor's `/` menu. */
  slash?: boolean;
  /** In the note's ⋯ menu (in list order). */
  noteMenu?: boolean;
  danger?: boolean;
  /** A link (downloads) rather than an action. */
  href?: (c: Ctx) => string;
  when(c: Ctx): boolean;
  run(c: Ctx): void;
}

// Conditions.
const writable = (c: Ctx) => !!c.note && !c.note.readOnly;
const editing = (c: Ctx) => writable(c) && c.note!.mode !== "read" && !!c.note!.editor;
const live = (c: Ctx) => editing(c) && c.note!.mode === "edit";
const ed = (c: Ctx) => c.note!.editor!;
const canCreate = (c: Ctx) => !!c.app?.canWrite;

/** Editor inserts, for the `/` menu and the palette. */
const insert = (id: string, title: string, icon: string, keywords: string, run: (e: EditorHandle) => void): Command => ({
  id: `insert.${id}`,
  title,
  group: "Insert",
  icon,
  keywords,
  slash: true,
  when: editing,
  run: (c) => run(ed(c)),
});

export const COMMANDS: Command[] = [
  // ── Insert (the `/` menu) ──────────────────────────────────────────────────────────────
  insert("h1", "Heading 1", "heading", "title h1 #", (e) => e.setBlock("# ")),
  insert("h2", "Heading 2", "heading", "subtitle h2 ##", (e) => e.setBlock("## ")),
  insert("h3", "Heading 3", "heading", "h3 ###", (e) => e.setBlock("### ")),
  insert("bullets", "Bulleted list", "list", "ul unordered points -", (e) => e.setBlock("- ")),
  insert("numbers", "Numbered list", "list-ordered", "ol ordered 1.", (e) => e.setBlock("1. ")),
  insert("todo", "To-do", "check", "task checkbox [ ]", (e) => e.setBlock("- [ ] ")),
  insert("quote", "Quote", "quote", "blockquote >", (e) => e.setBlock("> ")),
  insert("callout", "Callout", "callout", "admonition note tip warning info box", (e) => e.snippet("> [!${note}] ${Title}\n> ${}")),
  insert("table", "Table", "table", "grid columns rows", (e) => e.snippet("| ${Column} | ${Column} |\n| --- | --- |\n| ${} |  |\n")),
  insert("code", "Code block", "code", "snippet pre fence ```", (e) => e.snippet("```${language}\n${}\n```")),
  insert("divider", "Divider", "divider", "rule hr line ---", (e) => e.snippet("---\n${}")),
  insert("link", "Link to a note", "link", "wikilink [[ internal", (e) => e.insert("[[", true)),
  insert("tag", "Tag", "tag", "label #", (e) => e.insert("#", true)),
  {
    id: "format.colour",
    title: "Colour…",
    group: "Insert",
    icon: "sparkle",
    keywords: "color colour highlight highlighter text red yellow green blue mark",
    shortcut: "⌘⇧H",
    when: editing,
    run: (c) => void pickColour(ed(c)),
  },
  insert("date", "Today's date", "calendar", "now day iso", (e) => e.insert(formatDate(new Date(), "YYYY-MM-DD"))),
  insert("time", "Current time", "clock", "now hour", (e) => e.insert(formatDate(new Date(), "HH:mm"))),
  {
    id: "insert.picture",
    title: "Insert picture",
    group: "Insert",
    icon: "image",
    keywords: "photo image camera upload attachment",
    slash: true,
    noteMenu: true,
    when: editing,
    run: (c) => c.note!.pickPicture(),
  },
  {
    id: "insert.template",
    title: "Insert template…",
    group: "Insert",
    icon: "template",
    keywords: "boilerplate snippet",
    slash: true,
    noteMenu: true,
    when: editing,
    run: (c) => c.note!.insertTemplate(),
  },
  {
    id: "insert.property",
    title: "Add property",
    group: "Insert",
    icon: "list",
    keywords: "frontmatter yaml metadata field",
    slash: true,
    noteMenu: true,
    when: live,
    run: (c) => ed(c).addProperty(),
  },

  {
    id: "insert.ai",
    title: "Ask AI here",
    group: "Insert",
    icon: "sparkle",
    keywords: "assistant claude chat @ write summarise",
    slash: true,
    when: editing,
    run: (c) => c.note!.askHere(),
  },
  {
    id: "ai.add",
    title: "Add an AI assistant",
    group: "Vault",
    icon: "sparkle",
    keywords: "boyai bring your own ai key claude openai model",
    slash: true,
    when: (c) => !!c.app,
    run: (c) => c.app!.addAssistant(),
  },

  // ── This note (the ⋯ menu) ─────────────────────────────────────────────────────────────
  { id: "note.source", title: "Source mode", group: "View", icon: "code", keywords: "markdown raw", noteMenu: true, when: (c) => writable(c) && c.note!.mode !== "source", run: (c) => c.note!.setMode("source") },
  { id: "note.live", title: "Live preview", group: "View", icon: "edit", keywords: "edit wysiwyg", noteMenu: true, when: (c) => writable(c) && c.note!.mode !== "edit", run: (c) => c.note!.setMode("edit") },
  { id: "note.split", title: "Edit and preview side by side", group: "View", icon: "split", keywords: "split", when: (c) => writable(c) && !c.note!.narrow && c.note!.mode !== "split", run: (c) => c.note!.setMode("split") },
  { id: "note.read", title: "Reading view", group: "View", icon: "book", keywords: "preview read only", when: (c) => !!c.note && c.note.mode !== "read", run: (c) => c.note!.setMode("read") },
  { id: "note.typed", title: "Turn into a typed note…", group: "Note", icon: "sparkle", keywords: "convert make person task project object type extract link new note from selection line", when: (c) => writable(c) && typesState().types.length > 0, run: (c) => c.note!.makeTyped() },
  { id: "note.history", title: "Version history", group: "Note", icon: "history", keywords: "revisions restore undo old", noteMenu: true, when: (c) => !!c.note, run: (c) => c.note!.history() },
  { id: "note.download", title: "Download .md", group: "Note", icon: "download", keywords: "export markdown file", noteMenu: true, when: (c) => !!c.note, href: (c) => c.note!.downloadHref, run: (c) => void (location.href = c.note!.downloadHref) },
  { id: "note.bookmark", title: "Bookmark", group: "Note", icon: "bookmark", keywords: "star favourite pin sidebar", noteMenu: true, when: (c) => !!c.note && !c.note.bookmarked, run: (c) => c.note!.bookmark() },
  { id: "note.unbookmark", title: "Remove bookmark", group: "Note", icon: "bookmark", keywords: "unstar favourite pin", noteMenu: true, when: (c) => !!c.note && c.note.bookmarked, run: (c) => c.note!.bookmark() },
  { id: "note.copylink", title: "Copy wikilink", group: "Note", icon: "link", keywords: "clipboard [[", noteMenu: true, when: (c) => !!c.note, run: (c) => c.note!.copyLink() },
  { id: "note.rename", title: "Rename", group: "Note", icon: "edit", keywords: "title name", noteMenu: true, when: writable, run: (c) => c.note!.rename() },
  { id: "note.move", title: "Move to…", group: "Note", icon: "folder", keywords: "file folder organise", noteMenu: true, when: writable, run: (c) => c.note!.moveTo() },
  { id: "note.trash", title: "Move to Trash", group: "Note", icon: "trash", keywords: "delete remove", noteMenu: true, danger: true, when: writable, run: (c) => c.note!.trash() },

  // ── Create, go, vault (the palette) ────────────────────────────────────────────────────
  { id: "create.note", title: "New note", group: "Create", icon: "plus", shortcut: "⌥N", keywords: "add page", when: canCreate, run: (c) => c.app!.newNote() },
  { id: "create.template", title: "New note from template", group: "Create", icon: "template", when: canCreate, run: (c) => c.app!.newFromTemplate() },
  { id: "create.typed", title: "New note of a type…", group: "Create", icon: "shapes", keywords: "type object person meeting project book thing", when: canCreate, run: (c) => c.app!.newTyped() },
  { id: "create.weblink", title: "Save a web link…", group: "Create", icon: "link", keywords: "url bookmark article page web clip read later weblink", when: canCreate, run: (c) => c.app!.saveLink() },
  { id: "create.type", title: "New type", group: "Create", icon: "shapes", keywords: "type object schema properties define kind", when: canCreate, run: (c) => c.app!.newType() },
  { id: "create.github", title: "New vault from GitHub…", group: "Create", icon: "branch", keywords: "repo repository git clone import pull request docs", when: (c) => !!c.app, run: (c) => c.app!.newGitVault() },
  { id: "git.review", title: "Review changes", group: "Vault", icon: "branch", keywords: "github git diff branch changed", when: (c) => !!c.app?.git, run: (c) => c.app!.git!.review() },
  { id: "git.pr", title: "Open pull request", group: "Vault", icon: "pull-request", keywords: "github pr push commit", when: (c) => !!c.app?.canWrite && !!c.app.git && !c.app.git.hasPr && c.app.git.changes > 0, run: (c) => c.app!.git!.pullRequest() },
  { id: "git.push", title: "Push changes to the pull request", group: "Vault", icon: "pull-request", keywords: "github pr commit", when: (c) => !!c.app?.canWrite && !!c.app.git?.hasPr && c.app.git.unpushed > 0, run: (c) => c.app!.git!.pullRequest() },
  { id: "git.update", title: "Update from GitHub", group: "Vault", icon: "download", keywords: "pull main merge sync fetch", when: (c) => !!c.app?.canWrite && !!c.app.git, run: (c) => c.app!.git!.update() },
  { id: "git.cancel", title: "Cancel the branch", group: "Vault", icon: "undo", keywords: "github discard revert reset", danger: true, when: (c) => !!c.app?.canWrite && !!c.app.git && (c.app.git.changes > 0 || c.app.git.pushed), run: (c) => c.app!.git!.cancel() },
  { id: "create.folder", title: "New folder", group: "Create", icon: "folder-plus", keywords: "directory", when: (c) => canCreate(c) && !!c.sidebar, run: (c) => c.sidebar!.newFolder() },
  { id: "go.today", title: "Today's note", group: "Go", icon: "calendar", keywords: "daily journal", when: (c) => !!c.app, run: (c) => c.app!.today() },
  { id: "go.find", title: "Find a note", group: "Go", icon: "search", shortcut: "⌘O", keywords: "open switcher quick", when: (c) => !!c.app, run: (c) => c.app!.findNote() },
  { id: "go.search", title: "Search", group: "Go", icon: "search", shortcut: "⌘⇧F", keywords: "full text find in notes", when: (c) => !!c.app, run: (c) => c.app!.search() },
  { id: "go.tasks", title: "Tasks", group: "Go", icon: "check", keywords: "todo to-do checklist due open done", when: (c) => !!c.app, run: (c) => c.app!.tasks() },
  { id: "go.graph", title: "Graph view", group: "Go", icon: "graph", keywords: "map links network", when: (c) => !!c.app, run: (c) => c.app!.graph() },
  { id: "go.home", title: "Vault home", group: "Go", icon: "vault", keywords: "start recent", when: (c) => !!c.app, run: (c) => c.app!.home() },
  { id: "view.files", title: "Show or hide the file panel", group: "View", icon: "panel-left", shortcut: "⌘\\", keywords: "sidebar files tree left folders focus", when: (c) => !!c.app, run: (c) => c.app!.toggleLeft() },
  { id: "view.ai", title: "Ask AI in the side panel", group: "View", icon: "sparkle", shortcut: "⌘J", keywords: "assistant chat claude librarian organise", when: (c) => !!c.app, run: (c) => c.app!.askAi() },
  { id: "view.focus", title: "Focus mode", group: "View", icon: "book", keywords: "zen distraction free writing typewriter hide everything", when: (c) => !!c.note && !focusModeOn(), run: () => setFocusMode(true) },
  { id: "view.unfocus", title: "Leave focus mode", group: "View", icon: "x", keywords: "zen distraction exit", when: (c) => !!c.note && focusModeOn(), run: () => setFocusMode(false) },
  { id: "view.panel", title: "Show or hide the side panel", group: "View", icon: "panel", keywords: "outline backlinks right sidebar calendar", when: (c) => !!c.note, run: (c) => c.app!.toggleRight() },
  { id: "vault.import", title: "Import markdown", group: "Vault", icon: "upload", keywords: "markdown zip upload", when: canCreate, run: () => openSettings("vault") },
  { id: "vault.export", title: "Export vault as .zip", group: "Vault", icon: "download", keywords: "download backup markdown", when: (c) => !!c.app, href: (c) => c.app!.exportHref, run: (c) => void (location.href = c.app!.exportHref) },
  { id: "vault.trash", title: "Trash", group: "Vault", icon: "trash", keywords: "deleted restore", when: canCreate, run: (c) => c.app!.trash() },
  // Settings (F17): one command per section, so ⌘K finds a setting by what it's about.
  { id: "settings.open", title: "Settings", group: "Settings", icon: "settings", keywords: "preferences options configure", when: (c) => !!c.app, run: () => openSettings() },
  { id: "settings.account", title: "Account", group: "Settings", icon: "user", keywords: "profile name password sign out log out", when: (c) => !!c.app, run: () => openSettings("account") },
  { id: "settings.vault", title: "Vault settings", group: "Settings", icon: "vault", keywords: "this vault members share invite people role rename export leave delete", when: (c) => !!c.app, run: () => openSettings("vault") },
  { id: "settings.site", title: "Publish as a website", group: "Settings", icon: "globe", keywords: "web site publish public page share link unlisted take down unpublish", when: (c) => !!c.app, run: () => openSettings("site") },
  { id: "settings.assistants", title: "AI assistants", group: "Settings", icon: "sparkle", keywords: "bring your own ai key model provider daily limit", when: (c) => !!c.app, run: () => openSettings("assistants") },
  { id: "settings.connections", title: "Connections", group: "Settings", icon: "link", keywords: "github token claude mcp code agent iphone share shortcut capture", when: (c) => !!c.app, run: () => openSettings("connections") },
  { id: "settings.admin", title: "Admin", group: "Settings", icon: "users", keywords: "accounts users create storage database", when: (c) => !!c.app?.isAdmin, run: () => openSettings("admin") },
];

/** The note's ⋯ menu, in this order. View switches are there only on a phone, where the header
 *  has one Edit/Read toggle instead of the mode buttons. */
const NOTE_MENU = ["note.source", "note.live", "note.bookmark", "note.unbookmark", "note.history", "note.download", "note.copylink", "insert.property", "insert.picture", "insert.template", "note.rename", "note.move", "note.trash"];
export function noteMenu(): Command[] {
  return NOTE_MENU.map((id) => COMMANDS.find((c) => c.id === id)!).filter((c) => c.when(ctx) && (c.group !== "View" || !!ctx.note?.narrow));
}

/** The commands that apply right now, optionally only those for one place. */
export function available(where?: "slash" | "noteMenu"): Command[] {
  return COMMANDS.filter((c) => (where ? c[where] : true) && c.when(ctx));
}
