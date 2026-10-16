// Stands in for web/lib/api.ts in the standalone build (build.ts swaps it in): the shared client
// code that reads notes through the server (embeds, types, Dataview) reads them from the open
// folder instead.

import { type PageData, readPage, type Result, runInline, runQuery, Vault } from "../src/dataview";
import { allNotes, attachmentUrl, getNote, noteFor, setContent, VAULT_ID } from "./vault";

export type { Note, NoteSummary, Role, User, Vault, Session } from "../web/lib/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// The folder's pages for Dataview, each read again only when its text or path changes.
const pages = new Map<number, { content: string; path: string; page: PageData }>();
let dvVault: Vault | null = null;

function folderVault(): Vault {
  let changed = false;
  const seen = new Set<number>();
  for (const n of allNotes()) {
    seen.add(n.id);
    const e = getNote(n.id);
    if (!e) continue;
    const had = pages.get(n.id);
    if (had && had.content === e.content && had.path === n.path) continue;
    const t = Date.parse(n.updated_at) || Date.now();
    pages.set(n.id, { content: e.content, path: n.path, page: readPage({ path: n.path, content: e.content, ctime: Date.parse(n.created_at ?? "") || t, mtime: t }) });
    changed = true;
  }
  for (const id of [...pages.keys()]) if (!seen.has(id)) (pages.delete(id), (changed = true));
  if (changed || !dvVault) dvVault = new Vault([...pages.values()].map((p) => p.page));
  return dvVault;
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const note = new RegExp(`^/vaults/${VAULT_ID}/notes/(\\d+)$`).exec(path);
  if (note) {
    const n = noteFor(Number(note[1]));
    if (!n) throw new ApiError(404, "That note isn't in this folder.");
    return n as T;
  }
  // Types (F16) are a server feature; a plain folder has none defined.
  if (path === `/vaults/${VAULT_ID}/types`) return { types: [], undefined: [] } as T;
  if (path === `/vaults/${VAULT_ID}/dataview` && opts.method === "POST") {
    const b = opts.body as { noteId: number | null; offset: number; tz?: string; items: { kind: "query" | "inline"; source: string }[] };
    const v = folderVault();
    const thisPath = b.noteId === null ? null : (allNotes().find((n) => n.id === b.noteId)?.path ?? null);
    return b.items.map((it) => (it.kind === "query" ? runQuery(it.source, v, { thisPath, offset: b.offset, tz: b.tz }) : runInline(it.source, v, { thisPath, offset: b.offset, tz: b.tz }))) as Result[] as T;
  }
  // dataviewjs (web/lib/dataviewjs.ts): the folder's pages, and a note's or file's text.
  if (path === `/vaults/${VAULT_ID}/dataview/pages`) return folderVault().pages as T;
  if (path.startsWith(`/vaults/${VAULT_ID}/dataview/file?`)) {
    const want = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("path") ?? "";
    const isNote = /\.md$/i.test(want) || !/\.[a-z0-9]{1,8}$/i.test(want);
    const note = isNote ? folderVault().resolve(want.replace(/\.md$/i, "")) : null;
    const hit = note ? allNotes().find((n) => n.path === note) : undefined;
    if (hit) return { text: getNote(hit.id)?.content ?? "" } as T;
    const url = await attachmentUrl(want);
    if (!url) throw new ApiError(404, `There's no file at ${want}`);
    return { text: await (await fetch(url)).text() } as T;
  }
  // Ticking a task in a Dataview result: flip that line, found by its number and text.
  const task = new RegExp(`^/vaults/${VAULT_ID}/notes/(\\d+)/tasks$`).exec(path);
  if (task && opts.method === "PATCH") {
    const id = Number(task[1]);
    const b = opts.body as { line: number; text: string; done: boolean };
    const e = getNote(id);
    if (!e) throw new ApiError(404, "That note isn't in this folder.");
    const lines = e.content.split("\n");
    let at = b.line;
    const isIt = (i: number) => TASK.test(lines[i] ?? "") && (lines[i] ?? "").includes(b.text);
    if (!isIt(at)) at = lines.findIndex((_, i) => isIt(i));
    if (at < 0) throw new ApiError(409, "That task has changed since the list was loaded.");
    lines[at] = lines[at]!.replace(TASK, (_, a, _b, c) => `${a}${b.done ? "x" : " "}${c}`);
    setContent(id, lines.join("\n"));
    // An open editor holds its own copy of the text: tell it to start again from this one.
    window.dispatchEvent(new CustomEvent("cp-note-replaced", { detail: id }));
    return undefined as T;
  }
  throw new ApiError(501, "That needs the Commonplace server.");
}
