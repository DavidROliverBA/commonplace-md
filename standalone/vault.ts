// The folder being edited: every .md file read into memory (so links, backlinks, tags and search
// need no server), the other files kept as handles for images. Two ways in:
//
// - A real folder (Chrome and Edge, through the File System Access API): edits are written back
//   to the files a moment after typing stops.
// - Files picked or dropped (Safari and Firefox, which can't write to a folder): edits stay in
//   this tab, and "Download changes" saves them as a zip of the changed files.

import { zipSync, strToU8 } from "fflate";
import { extractTags, findWikiLinks, isAttachmentPath, normalisePath, parseFrontmatter, titleFromPath } from "../src/markdown";
import type { Note, NoteSummary } from "../web/lib/api";

export const VAULT_ID = 1;

interface Entry {
  summary: NoteSummary;
  content: string;
  /** Worked out when first asked for and dropped when the text changes: its [[link]] targets,
   *  and its text lowercased for search. */
  links?: string[];
  lower?: string;
  /** Changed in this tab and not yet written (or, without a folder, not yet downloaded). */
  dirty: boolean;
}

type Dir = FileSystemDirectoryHandle;

const notes = new Map<number, Entry>();
/** Attachments by lowercased path: a handle in folder mode, the File itself otherwise. */
const files = new Map<string, { path: string; get: () => Promise<File> }>();
let root: Dir | null = null;
let name = "";
let seq = 0;
// Two signals. The note list changes when notes come, go, move, or change their tags, type or
// aliases: everything built from it (the tree, link lookups, backlinks) rebuilds then, and not on
// every keystroke. Status is the cheap one: what's unsaved.
const listeners = new Set<() => void>();
let list: NoteSummary[] = [];
const emit = () => {
  list = [...notes.values()].map((e) => e.summary);
  listeners.forEach((f) => f());
  emitStatus();
};
const statusListeners = new Set<() => void>();
let status = 0;
const emitStatus = () => {
  status++;
  statusListeners.forEach((f) => f());
};

export const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const subscribeStatus = (f: () => void) => (statusListeners.add(f), () => void statusListeners.delete(f));
export const statusVersion = () => status;
export const allNotes = () => list;
export const vaultName = () => name;
/** True when edits go straight back to the files on disk. */
export const canWrite = () => root !== null;
export const getNote = (id: number) => notes.get(id);
export const dirtyCount = () => {
  let n = 0;
  for (const e of notes.values()) if (e.dirty) n++;
  return n;
};
/** A note's [[link]] targets, without #headings. */
export function linksOf(id: number): string[] {
  const e = notes.get(id);
  if (!e) return [];
  return (e.links ??= findWikiLinks(e.content).map((l) => l.target.split("#")[0]!.trim()));
}
export function lowerOf(id: number): string {
  const e = notes.get(id);
  return e ? (e.lower ??= e.content.toLowerCase()) : "";
}
export const isOpen = () => name !== "";

export const supportsFolders = () => typeof (window as any).showDirectoryPicker === "function";

function summarise(id: number, path: string, content: string, updated: number): NoteSummary {
  const { data } = parseFrontmatter(content);
  const raw = data.aliases ?? data.alias;
  const aliases = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((a) => String(a).toLowerCase());
  return {
    id,
    path,
    title: titleFromPath(path),
    tags: extractTags(content),
    type: typeof data.type === "string" ? data.type : null,
    updated_at: new Date(updated).toISOString(),
    aliases: aliases.length ? aliases : null,
  };
}

function reset(label: string) {
  notes.clear();
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  files.clear();
  name = label || "Folder";
}

const SKIP = /^(\.|node_modules$)/; // hidden folders (.git, app settings) and dependencies

/** Read a folder chosen with the system picker: every .md file, and the rest as attachments. */
export async function openFolder(dir: Dir): Promise<void> {
  reset(dir.name);
  root = dir;
  // List every folder at once, then read the notes many at a time: one by one, a vault of
  // thousands takes seconds.
  const md: { path: string; fh: FileSystemFileHandle }[] = [];
  const walk = async (d: Dir, prefix: string): Promise<void> => {
    const sub: Promise<void>[] = [];
    for await (const [entryName, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (SKIP.test(entryName)) continue;
      const path = prefix ? `${prefix}/${entryName}` : entryName;
      if (h.kind === "directory") sub.push(walk(h as Dir, path));
      else {
        const fh = h as FileSystemFileHandle;
        if (/\.md$/i.test(entryName)) md.push({ path, fh });
        else if (isAttachmentPath(path)) files.set(path.toLowerCase(), { path, get: () => fh.getFile() });
      }
    }
    await Promise.all(sub);
  };
  await walk(dir, "");
  md.sort((a, b) => a.path.localeCompare(b.path));
  const read = await pool(md, 32, async ({ fh }) => {
    const f = await fh.getFile();
    return { content: await f.text(), modified: f.lastModified };
  });
  md.forEach(({ path }, i) => {
    const id = ++seq;
    const { content, modified } = read[i]!;
    notes.set(id, { summary: summarise(id, path, content, modified), content, dirty: false });
  });
  void remember(dir);
  emit();
}

/** `work` on each item, at most `limit` at once; results in the items' order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** Read files picked or dropped without folder access: kept in this tab only. */
export async function openFiles(picked: File[], label: string): Promise<void> {
  reset(label);
  root = null;
  const md: { path: string; f: File }[] = [];
  for (const f of picked) {
    // A folder pick gives "Folder/sub/note.md"; drop the folder's own name.
    const rel = ((f as any).webkitRelativePath || f.name).split("/");
    if (rel.length > 1) rel.shift();
    const path = rel.join("/");
    if (path.split("/").some((p: string) => SKIP.test(p))) continue;
    if (/\.md$/i.test(path)) md.push({ path, f });
    else if (isAttachmentPath(path)) files.set(path.toLowerCase(), { path, get: async () => f });
  }
  md.sort((a, b) => a.path.localeCompare(b.path));
  const texts = await pool(md, 32, ({ f }) => f.text());
  md.forEach(({ path, f }, i) => {
    const id = ++seq;
    notes.set(id, { summary: summarise(id, path, texts[i]!, f.lastModified), content: texts[i]!, dirty: false });
  });
  emit();
}

/** A note as the shared client code expects it (embeds fetch notes through web/lib/api). */
export function noteFor(id: number): Note | undefined {
  const e = notes.get(id);
  if (!e) return undefined;
  return { ...e.summary, vault_id: VAULT_ID, content: e.content, frontmatter: parseFrontmatter(e.content).data, version: 1, updated_by_name: null, role: "editor" };
}

// ── writing ───────────────────────────────────────────────────────────────────────────

async function fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  let d = root!;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
  return d.getFileHandle(parts.at(-1)!, { create });
}

async function writeFile(path: string, data: string | Blob) {
  const w = await (await fileHandle(path, true)).createWritable();
  await w.write(data);
  await w.close();
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const summaryTimers = new Map<number, ReturnType<typeof setTimeout>>();
const sameList = (a: string[] | null | undefined, b: string[] | null | undefined) => (a ?? []).join("\n") === (b ?? []).join("\n");
let saveError: ((e: unknown) => void) | null = null;
export const onSaveError = (f: (e: unknown) => void) => void (saveError = f);

/** The editor's text changed: keep it, and write it to disk shortly. */
export function setContent(id: number, content: string) {
  const e = notes.get(id);
  if (!e || e.content === content) return;
  e.content = content;
  e.links = e.lower = undefined;
  const wasDirty = e.dirty;
  e.dirty = true;
  clearTimeout(timers.get(id));
  if (root) timers.set(id, setTimeout(() => void flush(id), 500));
  if (!wasDirty) emitStatus();
  // Tags, type and aliases are read again once typing pauses; the list changes only if they did.
  clearTimeout(summaryTimers.get(id));
  summaryTimers.set(
    id,
    setTimeout(() => {
      const cur = notes.get(id);
      if (!cur) return;
      const next = summarise(id, cur.summary.path, cur.content, Date.now());
      const changed = !sameList(next.tags, cur.summary.tags) || next.type !== cur.summary.type || !sameList(next.aliases, cur.summary.aliases);
      if (changed) {
        cur.summary = next;
        emit();
      } else cur.summary.updated_at = next.updated_at;
    }, 400),
  );
}

/** Write one note now (or every pending one with no id). */
export async function flush(id?: number): Promise<void> {
  if (!root) return;
  const ids = id === undefined ? [...notes.keys()] : [id];
  for (const i of ids) {
    const e = notes.get(i);
    if (!e?.dirty) continue;
    clearTimeout(timers.get(i));
    const content = e.content;
    try {
      await writeFile(e.summary.path, content);
      if (e.content === content) e.dirty = false;
      emitStatus();
    } catch (err) {
      saveError?.(err);
    }
  }
  emit();
}

const exists = (path: string) => [...notes.values()].some((e) => e.summary.path.toLowerCase() === path.toLowerCase());

/** A new note at `path` (".md" added); a number is appended if the name is taken. */
export async function createNote(input: string, content = ""): Promise<NoteSummary> {
  let path = normalisePath(input);
  for (let n = 2; exists(path); n++) path = normalisePath(`${input.replace(/\.md$/i, "")} ${n}`);
  const id = ++seq;
  notes.set(id, { summary: summarise(id, path, content, Date.now()), content, dirty: !root });
  if (root) await writeFile(path, content);
  emit();
  return notes.get(id)!.summary;
}

/** Move a note to a new path. Links to it are left as they are, as in a plain folder of files. */
export async function renameNote(id: number, input: string): Promise<NoteSummary> {
  const e = notes.get(id)!;
  const to = normalisePath(input);
  if (to === e.summary.path) return e.summary;
  const from = e.summary.path;
  const caseOnly = to.toLowerCase() === from.toLowerCase();
  if (!caseOnly && exists(to)) throw new Error(`There's already a note at ${to}`);
  if (root) {
    await flush(id);
    if (caseOnly) {
      // On a Mac the two names are one file: writing the new one and deleting the old would
      // delete the note. Go through a temporary name instead.
      const tmp = `${from}.renaming`;
      await writeFile(tmp, e.content);
      await removeFile(from);
      await writeFile(to, e.content);
      await removeFile(tmp);
    } else {
      await writeFile(to, e.content);
      await removeFile(from);
    }
  }
  e.summary = summarise(id, to, e.content, Date.now());
  emit();
  return e.summary;
}

async function removeFile(path: string) {
  const parts = path.split("/");
  let d = root!;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  await d.removeEntry(parts.at(-1)!);
}

export async function deleteNote(id: number): Promise<void> {
  const e = notes.get(id);
  if (!e) return;
  clearTimeout(timers.get(id));
  if (root) await removeFile(e.summary.path);
  notes.delete(id);
  emit();
}

/** Save a pasted or dropped file next to the notes, in attachments/; returns its path. */
export async function addAttachment(file: File): Promise<string> {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const base = file.name && file.name !== "image.png" ? file.name : `Pasted image ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.${ext}`;
  let path = `attachments/${base}`;
  for (let n = 2; files.has(path.toLowerCase()); n++) path = `attachments/${base.replace(/(\.\w+)?$/, ` ${n}$1`)}`;
  if (root) await writeFile(path, file);
  files.set(path.toLowerCase(), { path, get: async () => file });
  return path;
}

/** Every changed note (without folder access) as one zip, for the person to save. */
export function changesZip(): Blob {
  const out: Record<string, Uint8Array> = {};
  for (const e of notes.values()) if (e.dirty) out[e.summary.path] = strToU8(e.content);
  return new Blob([zipSync(out)], { type: "application/zip" });
}
export function markAllSaved() {
  for (const e of notes.values()) e.dirty = false;
  emit();
}

// ── attachments ───────────────────────────────────────────────────────────────────────

const blobUrls = new Map<string, string>();
const TYPES: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** A URL for an attachment the note names: its path, or (as wikilinks allow) just its name. */
export async function attachmentUrl(path: string): Promise<string | null> {
  const key = path.toLowerCase().replace(/^\.?\//, "");
  const hit = files.get(key) ?? [...files.values()].find((f) => f.path.toLowerCase().endsWith("/" + key));
  if (!hit) return null;
  let url = blobUrls.get(hit.path);
  if (!url) {
    const f = await hit.get();
    // Files read from a folder can come without a type, and an SVG won't show without one.
    const ext = hit.path.split(".").pop()!.toLowerCase();
    url = URL.createObjectURL(f.type ? f : new Blob([f], { type: TYPES[ext] ?? "application/octet-stream" }));
    blobUrls.set(hit.path, url);
  }
  return url;
}

// ── the last folder, to reopen with one click ─────────────────────────────────────────

const DB = "commonplace-standalone";
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function remember(dir: Dir) {
  try {
    const db = await idb();
    db.transaction("handles", "readwrite").objectStore("handles").put(dir, "last");
  } catch {
    // Not kept (a private window): the folder is just picked again next time.
  }
}
export async function lastFolder(): Promise<Dir | null> {
  try {
    const db = await idb();
    return await new Promise((ok) => {
      const r = db.transaction("handles").objectStore("handles").get("last");
      r.onsuccess = () => ok((r.result as Dir) ?? null);
      r.onerror = () => ok(null);
    });
  } catch {
    return null;
  }
}
