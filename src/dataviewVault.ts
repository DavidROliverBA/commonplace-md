// The pages Dataview queries read (src/dataview.ts), per vault, kept between queries: each note
// is read once per version, so a query after an edit rereads only the notes that changed.

import { HttpError } from "./auth";
import { sql } from "./db";
import { type PageData, readPage, type Result, runInline, runQuery, Vault } from "./dataview";

interface Cached {
  pages: Map<number, { path: string; at: number; page: PageData }>;
  vault: Vault | null;
}

const vaults = new Map<number, Cached>();
const MAX_VAULTS = 20;

export async function dataviewVault(vaultId: number): Promise<{ vault: Vault; pathOf: (id: number) => string | null }> {
  let c = vaults.get(vaultId);
  if (!c) {
    c = { pages: new Map(), vault: null };
    vaults.set(vaultId, c);
    if (vaults.size > MAX_VAULTS) vaults.delete(vaults.keys().next().value!);
  }
  const rows = await sql<{ id: number; path: string; updated_at: Date }[]>`select id, path, updated_at from notes where vault_id = ${vaultId}`;
  const seen = new Set<number>();
  const stale: number[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    seen.add(id);
    const had = c.pages.get(id);
    if (!had || had.at !== r.updated_at.getTime() || had.path !== r.path) stale.push(id);
  }
  let changed = stale.length > 0;
  for (const id of [...c.pages.keys()]) if (!seen.has(id)) (c.pages.delete(id), (changed = true));
  for (let i = 0; i < stale.length; i += 500) {
    const batch = await sql<{ id: number; path: string; content: string; created_at: Date; updated_at: Date }[]>`
      select id, path, content, created_at, updated_at from notes where vault_id = ${vaultId} and id = any(${stale.slice(i, i + 500)})`;
    for (const n of batch) {
      const page = readPage({ path: n.path, content: n.content, ctime: n.created_at.getTime(), mtime: n.updated_at.getTime() });
      c.pages.set(Number(n.id), { path: n.path, at: n.updated_at.getTime(), page });
    }
  }
  if (changed || !c.vault) c.vault = new Vault([...c.pages.values()].map((p) => p.page));
  const cache = c;
  return { vault: c.vault, pathOf: (id) => cache.pages.get(id)?.path ?? null };
}

/** The vault's pages for dataviewjs, which runs on them in the reader's browser (web/sandbox). */
export async function dataviewPages(vaultId: number): Promise<PageData[]> {
  return (await dataviewVault(vaultId)).vault.pages;
}

/** A note's or file's text, by path (dv.io.load, dv.view): a note by the app's link rules first. */
export async function dataviewFile(vaultId: number, path: string): Promise<string> {
  const isNote = /\.md$/i.test(path) || !/\.[a-z0-9]{1,8}$/i.test(path);
  if (isNote) {
    const { vault } = await dataviewVault(vaultId);
    const note = vault.resolve(path.replace(/\.md$/i, ""));
    const [n] = note ? await sql<{ content: string }[]>`select content from notes where vault_id = ${vaultId} and path = ${note}` : [];
    if (n) return n.content;
  }
  const [f] = await sql<{ data: Uint8Array; size: number }[]>`select data, size from attachments where vault_id = ${vaultId} and path = ${path.replace(/^\/+/, "")}`;
  if (!f) throw new HttpError(404, `There's no file at ${path}`);
  if (f.size > 5_000_000) throw new HttpError(413, "That file is too big to read in a view");
  return new TextDecoder().decode(f.data);
}

export interface DataviewItem {
  kind: "query" | "inline";
  source: string;
}

/** Run a note's queries and inline expressions together, as the reader sees them. */
export async function runDataview(vaultId: number, noteId: number | null, offset: number, items: DataviewItem[], tz?: string): Promise<Result[]> {
  const { vault, pathOf } = await dataviewVault(vaultId);
  const thisPath = noteId === null ? null : pathOf(noteId);
  return items.map((it) => (it.kind === "query" ? runQuery(it.source, vault, { thisPath, offset, tz }) : runInline(it.source, vault, { thisPath, offset, tz })));
}
