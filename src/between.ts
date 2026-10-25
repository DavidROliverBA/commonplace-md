// Copying and moving notes from one vault to another (a GitHub vault is a vault like any other):
// one note or a whole folder, with the pictures and files its notes embed, and the type notes
// they use when the other vault hasn't got that type yet. Clashing paths keep both ("Plan 1").
// A move carries each note's history across and then sends the original to Trash, so it can be
// put back; files are only ever copied, never removed. Used by the app (POST /send) and by the
// assistant's copy_to_vault tool (src/tools.ts), always as the person, with their roles in both.

import { HttpError, type User } from "./auth";
import { flushNote, kick } from "./collab";
import { sql } from "./db";
import { findWikiLinks, isAttachmentPath, normalisePath, normaliseTarget, parseFrontmatter, rewriteWikiLinks, titleFromPath } from "./markdown";
import * as notes from "./notes";
import { assertRoom } from "./storage";
import { typeOf, TYPES_FOLDER } from "./types";
import { viewsPath } from "./typeIndex";
import * as vaults from "./vaults";

export interface SendRequest {
  from: number;
  to: number;
  /** Notes to send, by id; or else `folder`, everything in it (and below). */
  notes?: number[];
  folder?: string;
  /** The folder in the other vault to put them in ("" is the top level). */
  into: string;
  move: boolean;
}

interface PlannedNote {
  id: number;
  path: string;
  to: string;
  content: string;
}
interface PlannedFile {
  path: string;
  to: string;
  size: number;
}

export interface SendPlan {
  from: { id: number; name: string };
  to: { id: number; name: string };
  move: boolean;
  notes: PlannedNote[];
  files: PlannedFile[];
  /** Type notes (Types/X.md) the other vault lacks, copied so the notes keep their type. */
  types: { path: string; content: string }[];
  /** Notes staying behind that link to a moved note: their links will no longer find it. */
  linkedFrom: number;
}

export interface SendReport {
  from: number;
  to: number;
  move: boolean;
  /** Each note made in the other vault (type notes included), for Undo. */
  created: { id: number; path: string; from: string | null }[];
  files: string[];
  /** The originals in Trash after a move, for Undo. */
  trashIds: number[];
}

const MAX_NOTES = 2000;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const within = (into: string, rel: string) => (into ? `${into}/${rel}` : rel);

/** The vault a send goes to: 404 for one that isn't yours, as everywhere. */
async function vaultOf(user: User, id: number, min: vaults.Role) {
  await vaults.requireRole(id, user, min);
  const v = (await vaults.listVaults(user.id)).find((x) => x.id === id)!;
  return { id: v.id, name: v.name };
}

/** The attachment an embed means, resolved as the app shows it (src/api.ts /files). */
async function attachmentFor(vaultId: number, target: string) {
  const p = target.split("#")[0]!.trim();
  const [f] = await sql<{ path: string; size: number }[]>`
    select path, size from attachments
    where vault_id = ${vaultId} and (lower(path) = lower(${p}) or lower(path) like ${"%/" + p.toLowerCase().replace(/[%_\\]/g, "\\$&")})
    order by (lower(path) = lower(${p})) desc, length(path) limit 1`;
  return f ?? null;
}

/** Where a file lands: its own path if that's free or holds the same bytes, else "x 1.png". */
async function freeFilePath(from: number, src: string, to: number, path: string, taken: Set<string>): Promise<string | null> {
  for (let i = 0; ; i++) {
    const p = i ? path.replace(/( \d+)?(\.[^.]+)$/, ` ${i}$2`) : path;
    if (taken.has(p.toLowerCase())) continue;
    const [there] = await sql`select md5(data) as h from attachments where vault_id = ${to} and lower(path) = lower(${p})`;
    if (!there) return p;
    const [mine] = await sql`select md5(data) as h from attachments where vault_id = ${from} and path = ${src}`;
    if (there.h === mine?.h) return null; // already there
  }
}

/** What a send would do, worked out without writing. Notes are read live (unsaved typing too). */
export async function planSend(user: User, r: SendRequest): Promise<SendPlan> {
  if (r.from === r.to) throw new HttpError(400, "That's the vault they're in already");
  const from = await vaultOf(user, r.from, r.move ? "editor" : "viewer");
  const to = await vaultOf(user, r.to, "editor");
  const into = r.into ? normalisePath(r.into, null) : "";

  let picked: { id: number; path: string }[];
  let folder = "";
  if (r.notes?.length) {
    picked = await sql`select id, path from notes where vault_id = ${from.id} and id in ${sql(r.notes)} order by path`;
    if (picked.length !== new Set(r.notes).size) throw new HttpError(404, "Note not found");
  } else if (r.folder) {
    folder = normalisePath(r.folder, null);
    const like = folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
    picked = await sql`select id, path from notes where vault_id = ${from.id} and lower(path) like ${like} order by path`;
  } else throw new HttpError(400, "Say which notes or folder");
  if (picked.length > MAX_NOTES) throw new HttpError(400, `That's more than ${MAX_NOTES} notes: send a smaller folder`);
  // A folder keeps its name and layout inside `into`; a note goes straight in.
  const relOf = (p: string) => (folder ? `${nameOf(folder)}/${p.slice(folder.length + 1)}` : nameOf(p));

  const plan: SendPlan = { from, to, move: r.move, notes: [], files: [], types: [], linkedFrom: 0 };
  const takenNotes = new Set<string>();
  const freeNote = async (path: string) => {
    let p = await notes.freeNotePath(to.id, path);
    for (let i = 1; takenNotes.has(p.toLowerCase()); i++) p = await notes.freeNotePath(to.id, path.replace(/\.md$/i, ` ${i}.md`));
    takenNotes.add(p.toLowerCase());
    return p;
  };
  for (const n of picked) {
    await flushNote(n.id);
    const { content } = await notes.getNote(from.id, n.id);
    plan.notes.push({ id: n.id, path: n.path, to: await freeNote(within(into, relOf(n.path))), content });
  }

  // Files: everything under a sent folder, and whatever the notes embed.
  const takenFiles = new Set<string>();
  const files = new Map<string, PlannedFile | null>();
  const addFile = async (path: string, size: number, dest: string) => {
    if (files.has(path)) return;
    const at = await freeFilePath(from.id, path, to.id, dest, takenFiles);
    if (at) takenFiles.add(at.toLowerCase());
    files.set(path, at ? { path, to: at, size } : null);
  };
  if (folder) {
    const like = folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
    for (const f of await sql<{ path: string; size: number }[]>`select path, size from attachments where vault_id = ${from.id} and lower(path) like ${like} order by path`) {
      await addFile(f.path, f.size, within(into, relOf(f.path)));
    }
  }
  for (const n of plan.notes) {
    for (const l of findWikiLinks(n.content)) {
      if (!l.embed || !isAttachmentPath(l.target)) continue;
      const f = await attachmentFor(from.id, l.target);
      if (!f) continue;
      await addFile(f.path, f.size, f.path); // kept where it was, so other notes find it too
      const moved = files.get(f.path);
      // Renamed to avoid a different file of the same name: point the embed at the new name.
      if (moved && moved.to !== f.path) n.content = rewriteWikiLinks(n.content, (t) => t === normaliseTarget(l.target), moved.to);
    }
  }

  // Types the other vault hasn't got, so a Meeting arrives as a Meeting.
  const typeNames = new Set(plan.notes.map((n) => typeOf(parseFrontmatter(n.content).data)).filter((t): t is string => !!t));
  for (const t of typeNames) {
    const path = normalisePath(`${TYPES_FOLDER}/${t}`);
    if (plan.notes.some((n) => n.to.toLowerCase() === path.toLowerCase())) continue;
    if (await notes.findByPath(to.id, path)) continue;
    const def = await notes.findByPath(from.id, path);
    if (!def) continue;
    await flushNote(def.id);
    plan.types.push({ path, content: (await notes.getNote(from.id, def.id)).content });
    const views = await sql<{ size: number }[]>`select size from attachments where vault_id = ${from.id} and path = ${viewsPath(t)}`;
    if (views.length) await addFile(viewsPath(t), views[0]!.size, viewsPath(t));
  }
  plan.files = [...files.values()].filter((f): f is PlannedFile => !!f);

  if (r.move) {
    const ids = new Set(plan.notes.map((n) => n.id));
    const linkers = new Set<number>();
    for (const n of plan.notes) for (const l of await notes.backlinks(from.id, n.id)) if (!ids.has(l.id)) linkers.add(l.id);
    plan.linkedFrom = linkers.size;
  }
  return plan;
}

/** One line saying what a plan does, for the assistant's preview and the app's dialog. */
export function describePlan(p: SendPlan): string {
  const what = p.notes.length === 1 ? `“${titleFromPath(p.notes[0]!.path)}”` : `${p.notes.length} notes`;
  const where = p.notes.length === 1 ? parentOf(p.notes[0]!.to) : "";
  const extras = [p.files.length ? `${p.files.length} file${p.files.length === 1 ? "" : "s"}` : "", p.types.length ? `the ${p.types.map((t) => titleFromPath(t.path)).join(", ")} type${p.types.length === 1 ? "" : "s"}` : ""].filter(Boolean);
  const links = p.linkedFrom ? `; ${p.linkedFrom} note${p.linkedFrom === 1 ? "" : "s"} left in ${p.from.name} link to ${p.notes.length === 1 ? "it" : "them"}` : "";
  return `${p.move ? "Move" : "Copy"} ${what} to ${p.to.name}${where ? ` (${where})` : ""}${extras.length ? `, with ${extras.join(" and ")}` : ""}${p.move ? `; the original${p.notes.length === 1 ? "" : "s"} go${p.notes.length === 1 ? "es" : ""} to Trash` : ""}${links}`;
}

/** Copy (or move) as planned. Plans again first, so it acts on the notes as they are now. */
export async function send(user: User, r: SendRequest): Promise<SendReport> {
  // A move closes the notes' live rooms first, so nobody types into an original on its way out.
  if (r.move) for (const n of (await planSend(user, r)).notes) kick({ noteId: n.id }, "note deleted");
  const p = await planSend(user, r);
  if (!p.notes.length) throw new HttpError(400, "There are no notes to send");
  await assertRoom(p.notes.reduce((s, n) => s + Buffer.byteLength(n.content), 0) + p.files.reduce((s, f) => s + f.size, 0));
  const report: SendReport = { from: p.from.id, to: p.to.id, move: p.move, created: [], files: [], trashIds: [] };

  for (const f of p.files) {
    await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
              select ${p.to.id}, ${f.to}, mime, size, data, ${user.id} from attachments where vault_id = ${p.from.id} and path = ${f.path}
              on conflict (vault_id, path) do nothing`;
    report.files.push(f.to);
  }
  for (const t of p.types) {
    const made = await notes.createNote(p.to.id, user.id, t.path, t.content, false);
    report.created.push({ id: made.id, path: made.path, from: null });
  }
  for (const n of p.notes) {
    const made = await notes.createNote(p.to.id, user.id, n.to, n.content, false);
    report.created.push({ id: made.id, path: made.path, from: n.path });
    if (!p.move) continue;
    // The note's history goes with it, and it keeps when and by whom it was made.
    await sql.begin(async (tx) => {
      await tx`update notes set created_by = o.created_by, created_at = o.created_at from notes o where o.id = ${n.id} and notes.id = ${made.id}`;
      await tx`insert into note_revisions (note_id, content, author_id, reason, created_at)
               select ${made.id}, content, author_id, reason, created_at from note_revisions where note_id = ${n.id} order by id`;
    });
    report.trashIds.push(await notes.deleteNote(p.from.id, n.id, user.id));
  }
  return report;
}
