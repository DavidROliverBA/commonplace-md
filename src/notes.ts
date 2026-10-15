// Notes: CRUD, the derived index (title, tags, frontmatter, links), revisions, Trash, folders and
// link resolution (backlinks, outgoing links, the graph).
//
// Every write goes through `persist()`, which re-derives the index from the markdown in the same
// transaction, so search, tags and backlinks can never disagree with the text. Writes that come
// from outside the live editor (REST, import, restore) go through `overwriteContent()`, which
// routes into an open collaboration room when there is one — otherwise people editing the note
// would have the change silently undone by their next keystroke.

import { HttpError } from "./auth";
import { sql } from "./db";
import { scheduleEmbedding } from "./embed";
import { emit } from "./events";
import { assertNoteSize, assertRoom } from "./storage";
import { rebaseStoredDoc } from "./ydoc";
import { extractLinks, extractTags, normalisePath, normaliseTarget, parseFrontmatter, rewriteWikiLinks, titleFromPath } from "./markdown";

export interface NoteSummary {
  id: number;
  path: string;
  title: string;
  tags: string[];
  updated_at: string;
  /** Its type (F16), from `type:` in its frontmatter. */
  type: string | null;
  created_at: string;
  /** Other names links can use (aliases, id), lowercased; null if none. */
  aliases?: string[] | null;
}

export interface Note extends NoteSummary {
  vault_id: number;
  content: string;
  frontmatter: Record<string, unknown>;
  version: number;
  updated_by_name: string | null;
}

const REVISION_INTERVAL_MIN = 10;
/** Versions kept per note (all the history panel lists); older ones are pruned. */
export const REVISIONS_KEPT = 100;
/** Writes by agents and syncs keep the version before their first change in a burst, not one per
 *  call, so an agent looping over a note can't fill the database with copies of it. */
const BURST_REASONS = new Set(["mcp", "ai", "github"]);

/** New text for a note: the whole of it, or a function of its current text (an append). */
export type NextContent = string | ((current: string) => string);
const resolveNext = (next: NextContent, current: string) => (typeof next === "string" ? next : next(current));

/**
 * Set by collab.ts: if a live room is open (or opening) for the note, push the text into it and
 * return the promise; otherwise return null. Must decide synchronously — see overwriteContent.
 * A function is applied to the room's live text, so an append can't undo what someone is typing.
 */
let liveOverwrite: (noteId: number, next: NextContent, userId: number | null) => Promise<void> | null = () => null;
export function setLiveOverwrite(fn: typeof liveOverwrite) {
  liveOverwrite = fn;
}

/** Offline writes in flight per note; a room opening for that note waits for them first. */
const barriers = new Map<number, Promise<unknown>>();
export function writeBarrier(noteId: number): Promise<unknown> {
  return (barriers.get(noteId) ?? Promise.resolve()).catch(() => {});
}

export async function listNotes(vaultId: number): Promise<NoteSummary[]> {
  return sql<NoteSummary[]>`
    select id, path, title, tags, updated_at, created_at, type_name as type, nullif(link_names, '{}') as aliases
    from notes where vault_id = ${vaultId} order by lower(path)`;
}

export async function getNote(vaultId: number, id: number): Promise<Note> {
  const [n] = await sql<Note[]>`
    select n.id, n.vault_id, n.path, n.title, n.tags, n.content, n.frontmatter, n.version,
           n.updated_at, n.created_at, n.type_name as type, u.name as updated_by_name
    from notes n left join users u on u.id = n.updated_by
    where n.vault_id = ${vaultId} and n.id = ${id}`;
  if (!n) throw new HttpError(404, "Note not found");
  return n;
}

export async function findByPath(vaultId: number, path: string) {
  const [n] = await sql`select id, path from notes where vault_id = ${vaultId} and lower(path) = lower(${path})`;
  return n as { id: number; path: string } | undefined;
}

function derive(path: string, content: string) {
  return {
    title: titleFromPath(path),
    tags: extractTags(content),
    frontmatter: parseFrontmatter(content).data,
    links: extractLinks(content),
  };
}

async function writeLinks(tx: any, vaultId: number, noteId: number, links: string[]) {
  await tx`delete from links where source_id = ${noteId}`;
  if (links.length) {
    await tx`insert into links ${tx(links.map((target) => ({ vault_id: vaultId, source_id: noteId, target })))} on conflict do nothing`;
  }
}

/** `checkRoom` false only for a restore from Trash, which moves data rather than adding it. */
export async function createNote(vaultId: number, userId: number | null, rawPath: string, content = "", checkRoom = true): Promise<Note> {
  const path = normalisePath(rawPath);
  assertNoteSize(content);
  if (checkRoom) await assertRoom(Buffer.byteLength(content));
  if (await findByPath(vaultId, path)) throw new HttpError(409, `A note already exists at ${path}`);
  const d = derive(path, content);
  const id = await sql.begin(async (tx) => {
    const [n] = await tx`
      insert into notes (vault_id, path, content, title, tags, frontmatter, created_by, updated_by)
      values (${vaultId}, ${path}, ${content}, ${d.title}, ${d.tags}, ${tx.json(d.frontmatter as any)}, ${userId}, ${userId})
      on conflict (vault_id, path) do nothing
      returning id`;
    // Lost a race with a simultaneous create of the same path (e.g. a double tap on New).
    if (!n) throw new HttpError(409, `A note already exists at ${path}`);
    await writeLinks(tx, vaultId, n.id, d.links);
    return n.id as number;
  });
  scheduleEmbedding(id);
  emit(vaultId, { type: "note.created", id, path, by: userId });
  return getNote(vaultId, id);
}

/**
 * Write new markdown for a note and re-derive its index. `ydoc` is the matching Yjs state, or
 * null only for a note that has never been opened live (the first room builds it from text).
 */
export async function persist(
  noteId: number,
  content: string,
  userId: number | null,
  ydoc: Uint8Array | null,
  reason = "edit",
): Promise<{ vaultId: number; path: string; version: number } | null> {
  const result = await sql.begin(async (tx) => {
    const [cur] = await tx`select vault_id, path, content from notes where id = ${noteId} for update`;
    if (!cur) return null;
    if (cur.content === content) {
      if (ydoc) await tx`update notes set ydoc = ${ydoc} where id = ${noteId}`;
      return null;
    }
    const [last] = await tx`select created_at from note_revisions where note_id = ${noteId} order by created_at desc limit 1`;
    const stale = !last || Date.now() - new Date(last.created_at).getTime() > REVISION_INTERVAL_MIN * 60_000;
    if (reason !== "edit" || stale) {
      await tx`insert into note_revisions (note_id, content, author_id, reason) values (${noteId}, ${cur.content}, ${userId}, ${reason})`;
    }
    const d = derive(cur.path, content);
    const [row] = await tx`
      update notes set content = ${content}, ydoc = ${ydoc}, tags = ${d.tags},
        frontmatter = ${tx.json(d.frontmatter as any)}, version = version + 1,
        updated_by = ${userId}, updated_at = now()
      where id = ${noteId} returning version`;
    await writeLinks(tx, cur.vault_id, noteId, d.links);
    return { vaultId: cur.vault_id as number, path: cur.path as string, version: row!.version as number };
  });
  if (result) {
    scheduleEmbedding(noteId);
    emit(result.vaultId, { type: "note.updated", id: noteId, path: result.path, version: result.version, by: userId });
  }
  return result;
}

/** Replace a note's markdown from outside the editor (REST, import, restore, capture). */
export async function overwriteContent(noteId: number, content: NextContent, userId: number | null, reason = "edit"): Promise<void> {
  if (typeof content === "string") assertNoteSize(content);
  await assertRoom();
  const snapshot = () =>
    reason === "edit"
      ? Promise.resolve()
      : sql`insert into note_revisions (note_id, content, author_id, reason)
            select id, content, ${userId}, ${reason} from notes where id = ${noteId}
              and not (${BURST_REASONS.has(reason)} and exists (
                select 1 from note_revisions r where r.note_id = ${noteId} and r.reason = ${reason}
                  and r.author_id is not distinct from ${userId}
                  and r.created_at > now() - make_interval(mins => ${REVISION_INTERVAL_MIN})))`;
  // Route decided in this tick (no await before it), so a room can't start loading in between.
  const live = liveOverwrite(noteId, content, userId);
  if (live) {
    await snapshot();
    await live; // the room persists it, with its CRDT state
    return;
  }
  const work = (async () => {
    await snapshot();
    const [cur] = await sql`select content, ydoc from notes where id = ${noteId}`;
    if (!cur) throw new HttpError(404, "Note not found");
    const text = resolveNext(content, cur.content);
    assertNoteSize(text);
    // Never drop existing CRDT state: diff the change into it so offline clients merge cleanly.
    const ydoc = cur.ydoc ? rebaseStoredDoc(cur.content, new Uint8Array(cur.ydoc), text) : null;
    await persist(noteId, text, userId, ydoc, "edit");
  })();
  const prev = barriers.get(noteId) ?? Promise.resolve();
  const chained = prev.catch(() => {}).then(() => work);
  chained.catch(() => {}); // the caller gets the error from `work`; this copy must not go unhandled
  barriers.set(noteId, chained);
  try {
    await work;
  } finally {
    if (barriers.get(noteId) === chained) barriers.delete(noteId);
  }
}

/** Move or rename a note; with `updateLinks`, [[links]] to it in other notes are rewritten. */
export async function renameNote(vaultId: number, id: number, rawPath: string, userId: number, updateLinks = true): Promise<Note> {
  const note = await getNote(vaultId, id);
  const path = normalisePath(rawPath);
  if (path === note.path) return note;
  const clash = await findByPath(vaultId, path);
  if (clash && clash.id !== id) throw new HttpError(409, `A note already exists at ${path}`);

  // Find linkers BEFORE the rename, while their targets still resolve to the old name.
  const linkers = updateLinks ? await backlinks(vaultId, id) : [];
  await sql`update notes set path = ${path}, title = ${titleFromPath(path)}, updated_at = now(), updated_by = ${userId} where id = ${id}`;
  emit(vaultId, { type: "note.renamed", id, path, from: note.path, by: userId });

  if (linkers.length) {
    const oldKeys = new Set([note.title.toLowerCase(), note.path.replace(/\.md$/i, "").toLowerCase()]);
    // Keep links short, as other Markdown editors do: the bare title unless that title is now ambiguous.
    const newTitle = titleFromPath(path);
    const [{ n }] = (await sql`select count(*)::int as n from notes where vault_id = ${vaultId} and lower(title) = lower(${newTitle})`) as any;
    const replacement = n > 1 ? path.replace(/\.md$/i, "") : newTitle;
    for (const l of linkers) {
      const src = await getNote(vaultId, l.id);
      const next = rewriteWikiLinks(src.content, (t) => oldKeys.has(t) || [...oldKeys].some((k) => k.endsWith("/" + t)), replacement);
      if (next !== src.content) await overwriteContent(src.id, next, userId);
    }
  }
  return getNote(vaultId, id);
}

/** Move a note to Trash, with its history, for TRASH_DAYS. Returns the Trash id, so the client
 *  can offer Undo (restore). Callers close and flush its live room first (see api.ts). */
export async function deleteNote(vaultId: number, id: number, userId: number): Promise<number> {
  const { path, trashId } = await sql.begin(async (tx) => {
    const [n] = await tx`
      insert into trashed_notes (vault_id, path, content, ydoc, revisions, created_by, created_at, deleted_by)
      select n.vault_id, n.path, n.content, n.ydoc,
             coalesce((select jsonb_agg(jsonb_build_object('content', r.content, 'author_id', r.author_id, 'reason', r.reason, 'created_at', r.created_at) order by r.id)
                       from note_revisions r where r.note_id = n.id), '[]'),
             n.created_by, n.created_at, ${userId}
      from notes n where n.vault_id = ${vaultId} and n.id = ${id}
      returning id, path`;
    if (!n) throw new HttpError(404, "Note not found");
    await tx`delete from notes where id = ${id}`;
    return { path: n.path as string, trashId: Number(n.id) };
  });
  emit(vaultId, { type: "note.deleted", id, path, by: userId });
  return trashId;
}

// ── Trash ─────────────────────────────────────────────────────────────────────────────────

export const TRASH_DAYS = 30;

export async function listTrash(vaultId: number) {
  return sql<{ id: number; path: string; title: string; deleted_at: string; deleted_by_name: string | null }[]>`
    select t.id, t.path, t.deleted_at, u.name as deleted_by_name
    from trashed_notes t left join users u on u.id = t.deleted_by
    where t.vault_id = ${vaultId} order by t.deleted_at desc`.then((rows) => rows.map((r) => ({ ...r, title: titleFromPath(r.path) })));
}

/** Put a trashed note back, with its history. If its path is taken now, it gets " 1", " 2"… */
export async function restoreNote(vaultId: number, trashId: number, userId: number): Promise<Note> {
  const [t] = await sql`select * from trashed_notes where vault_id = ${vaultId} and id = ${trashId}`;
  if (!t) throw new HttpError(404, "Not in Trash");
  const note = await createNote(vaultId, userId, await freeNotePath(vaultId, t.path), t.content, false);
  await sql.begin(async (tx) => {
    await tx`update notes set ydoc = ${t.ydoc}, created_by = ${t.created_by}, created_at = ${t.created_at} where id = ${note.id}`;
    const revs = t.revisions as { content: string; author_id: number | null; reason: string; created_at: string }[];
    if (revs.length) {
      await tx`insert into note_revisions ${tx(revs.map((r) => ({ note_id: note.id, content: r.content, author_id: r.author_id, reason: r.reason, created_at: r.created_at })))}`;
    }
    await tx`delete from trashed_notes where id = ${trashId}`;
  });
  return getNote(vaultId, note.id);
}

/** Delete one trashed note for good, or (no id) empty the vault's Trash. */
export async function purgeFromTrash(vaultId: number, trashId?: number): Promise<number> {
  const rows = trashId
    ? await sql`delete from trashed_notes where vault_id = ${vaultId} and id = ${trashId} returning 1`
    : await sql`delete from trashed_notes where vault_id = ${vaultId} returning 1`;
  if (trashId && !rows.length) throw new HttpError(404, "Not in Trash");
  return rows.length;
}

/** Drop everything trashed more than TRASH_DAYS ago, across all vaults. */
export async function purgeTrash(): Promise<number> {
  const rows = await sql`delete from trashed_notes where deleted_at < now() - make_interval(days => ${TRASH_DAYS}) returning 1`;
  return rows.length;
}

/** Keep each note's newest REVISIONS_KEPT versions; drop the rest. */
export async function pruneRevisions(): Promise<number> {
  const rows = await sql`
    delete from note_revisions r using (
      select id from (select id, row_number() over (partition by note_id order by created_at desc, id desc) as n from note_revisions) x
      where x.n > ${REVISIONS_KEPT}
    ) old where r.id = old.id returning 1`;
  return rows.length;
}

/** `path` if free, else "Name 1.md", "Name 2.md"… */
export async function freeNotePath(vaultId: number, path: string): Promise<string> {
  if (!(await findByPath(vaultId, path))) return path;
  const base = path.replace(/\.md$/i, "");
  for (let i = 1; ; i++) {
    const candidate = `${base} ${i}.md`;
    if (!(await findByPath(vaultId, candidate))) return candidate;
  }
}

/** Rename every note under a folder prefix (folders are implicit in paths). */
export async function renameFolder(vaultId: number, from: string, to: string, userId: number): Promise<number> {
  const src = normalisePath(from, null);
  const dst = normalisePath(to, null);
  if (dst === src) return 0;
  if (dst.toLowerCase().startsWith(src.toLowerCase() + "/")) throw new HttpError(400, "A folder can't be moved inside itself");
  // Moving onto an existing folder would silently merge the two; refuse (a case-only rename is fine).
  if (dst.toLowerCase() !== src.toLowerCase() && (await folderExists(vaultId, dst))) throw new HttpError(409, `A folder already exists at ${dst}`);
  const like = src.replace(/[%_\\]/g, "\\$&") + "/%";
  const rows = await sql`select id, path from notes where vault_id = ${vaultId} and path like ${like}`;
  // Check every destination first so a clash can't leave the folder half-moved.
  const moving = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const clash = await findByPath(vaultId, dst + r.path.slice(src.length));
    if (clash && !moving.has(clash.id)) throw new HttpError(409, `A note already exists at ${clash.path}`);
  }
  const [attClash] = await sql`
    select b.path from attachments a join attachments b
      on b.vault_id = a.vault_id and lower(b.path) = lower(${dst} || substr(a.path, ${src.length + 1}))
    where a.vault_id = ${vaultId} and a.path like ${like} and b.path not like ${like}`;
  if (attClash) throw new HttpError(409, `A file already exists at ${attClash.path}`);
  for (const r of rows) await renameNote(vaultId, r.id, dst + r.path.slice(src.length), userId);
  await sql`update attachments set path = ${dst} || substr(path, ${src.length + 1})
            where vault_id = ${vaultId} and path like ${src.replace(/[%_\\]/g, "\\$&") + "/%"}`;
  // Move the folder's own row and any empty subfolders with it.
  await sql.begin(async (tx) => {
    const moved = await tx`delete from folders where vault_id = ${vaultId} and (lower(path) = lower(${src}) or path like ${like}) returning path`;
    if (moved.length) {
      await tx`insert into folders ${tx(moved.map((f) => ({ vault_id: vaultId, path: dst + f.path.slice(src.length) })))} on conflict do nothing`;
    }
  });
  emit(vaultId, { type: "folders.changed", by: userId });
  return rows.length;
}

// ── Folders ───────────────────────────────────────────────────────────────────────────────

/** Folders stored on their own (empty ones, or created before their first note). */
export async function listFolders(vaultId: number): Promise<string[]> {
  return (await sql`select path from folders where vault_id = ${vaultId} order by path`).map((r) => r.path);
}

/** Whether anything (a stored folder, a note or a file) already lives at this folder path. */
async function folderExists(vaultId: number, path: string): Promise<boolean> {
  const like = path.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
  const [hit] = await sql`
    select 1 from folders where vault_id = ${vaultId} and lower(path) = lower(${path})
    union all select 1 from notes where vault_id = ${vaultId} and lower(path) like ${like}
    union all select 1 from attachments where vault_id = ${vaultId} and lower(path) like ${like}
    limit 1`;
  return !!hit;
}

export async function createFolder(vaultId: number, rawPath: string, userId: number): Promise<string> {
  const path = normalisePath(rawPath, null);
  if (await folderExists(vaultId, path)) throw new HttpError(409, `A folder already exists at ${path}`);
  const [row] = await sql`insert into folders (vault_id, path) values (${vaultId}, ${path}) on conflict do nothing returning path`;
  if (!row) throw new HttpError(409, `A folder already exists at ${path}`);
  emit(vaultId, { type: "folders.changed", by: userId });
  return path;
}

/** Delete an empty folder (and any empty subfolders). Refuses if any note or file is inside. */
export async function deleteFolder(vaultId: number, rawPath: string, userId: number): Promise<void> {
  const path = normalisePath(rawPath, null);
  const like = path.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
  const [busy] = await sql`
    select 1 from notes where vault_id = ${vaultId} and lower(path) like ${like}
    union all select 1 from attachments where vault_id = ${vaultId} and lower(path) like ${like}
    limit 1`;
  if (busy) throw new HttpError(409, "That folder isn't empty. Move or delete its notes first.");
  const gone = await sql`delete from folders where vault_id = ${vaultId} and (lower(path) = lower(${path}) or lower(path) like ${like}) returning 1`;
  if (!gone.length) throw new HttpError(404, "No such folder");
  emit(vaultId, { type: "folders.changed", by: userId });
}

/**
 * Notes linking to this one. A link matches if its normalised target is the note's title, its
 * full path, or a trailing part of its path ("sub/plan" matches "projects/sub/plan.md").
 */
export async function backlinks(vaultId: number, id: number) {
  return sql<{ id: number; path: string; title: string }[]>`
    with me as (${linkKeys(vaultId, sql`and n.id = ${id}`)})
    select distinct n.id, n.path, n.title
    from me join links l on l.vault_id = ${vaultId} and l.target = me.k join notes n on n.id = l.source_id
    where l.source_id <> ${id}
    order by n.title`;
}

/**
 * Every name a link can use for each note in the vault (optionally narrowed by `where`, on `n`),
 * as rows (id, k): its path without .md and each tail of that path, so "Area/Sub/Note 5" is
 * reached by `[[area/sub/note 5]]`, `[[sub/note 5]]` and `[[note 5]]` (the title), and its
 * aliases and id (`notes.link_names`, F9). Link targets
 * are stored the same way (`normaliseTarget`), so resolving links is an equality join that
 * Postgres can hash, not a "path ends with" test against every note.
 */
export function linkKeys(vaultId: number, where = sql``) {
  return sql`
    select n.id, lower(array_to_string(s.parts[i:], '/')) as k
    from notes n
      cross join lateral (select string_to_array(regexp_replace(n.path, '\\.md$', '', 'i'), '/') as parts) s
      cross join lateral generate_subscripts(s.parts, 1) as i
    where n.vault_id = ${vaultId} ${where}
    union all
    select n.id, a from notes n cross join unnest(n.link_names) as a
    where n.vault_id = ${vaultId} and n.link_names <> '{}' ${where}`;
}

/** This note's outgoing links, each resolved to a note id (or null for a not-yet-created note). */
export async function outgoing(vaultId: number, id: number) {
  const targets = await sql`select target from links where source_id = ${id} order by target`;
  const out: { target: string; id: number | null; path: string | null }[] = [];
  for (const { target } of targets) {
    const hit = await resolveLink(vaultId, target);
    out.push({ target, id: hit?.id ?? null, path: hit?.path ?? null });
  }
  return out;
}

/** Resolve wikilink text to a note: exact path, then title, then path suffix. Shortest path wins. */
export async function resolveLink(vaultId: number, target: string) {
  const t = normaliseTarget(target);
  // Every match has the link's last segment as its title, which narrows it by index first.
  const [hit] = await sql`
    select id, path from notes
    where vault_id = ${vaultId} and lower(title) = ${t.split("/").pop()!}
      and (lower(regexp_replace(path, '\\.md$', '', 'i')) = ${t}
           or lower(title) = ${t}
           or right(lower(regexp_replace(path, '\\.md$', '', 'i')), ${t.length + 1}) = ${"/" + t})
    order by (lower(regexp_replace(path, '\\.md$', '', 'i')) = ${t}) desc, length(path)
    limit 1`;
  if (hit) return hit as { id: number; path: string };
  // Then another name it goes by: an alias, or its id (F9).
  const [alias] = await sql`select id, path from notes where vault_id = ${vaultId} and link_names @> ${[t]}::text[] order by length(path) limit 1`;
  return alias as { id: number; path: string } | undefined;
}

export async function tagCounts(vaultId: number) {
  return sql`select tag, count(*)::int as count from notes, unnest(tags) as tag
             where vault_id = ${vaultId} group by tag order by tag`;
}

export async function graph(vaultId: number) {
  const nodes = await sql`select id, title, path, cardinality(tags) as tag_count from notes where vault_id = ${vaultId}`;
  const edges = await sql`
    with k as (${linkKeys(vaultId)})
    select distinct l.source_id as source, k.id as target
    from links l join k on k.k = l.target
    where l.vault_id = ${vaultId} and l.source_id <> k.id`;
  return { nodes, edges };
}

export async function revisions(noteId: number) {
  return sql`select r.id, r.created_at, r.reason, u.name as author, length(r.content) as size
             from note_revisions r left join users u on u.id = r.author_id
             where r.note_id = ${noteId} order by r.created_at desc limit 100`;
}

export async function revision(noteId: number, revId: number) {
  const [r] = await sql`select id, content, created_at from note_revisions where note_id = ${noteId} and id = ${revId}`;
  if (!r) throw new HttpError(404, "Revision not found");
  return r;
}
