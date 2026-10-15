// Storage guard (N9): the database disk is a fixed size (DB_DISK_GB, 1 GB on Render, with
// autoscaling deliberately off), and Render suspends a database that fills it. So the server
// watches its own size and, near the limit, refuses writes that add data (new notes, files,
// imports, GitHub copies, agents' edits) with a message saying why. Typing in an open note keeps
// working, so nobody loses what they're writing. Admins see how full it is in Settings → Admin.

import { HttpError } from "./auth";
import { sql } from "./db";
import { settings } from "./settings";

/** Above this share of the disk, admins are warned. */
export const WARN_AT = 0.8;
/** Above this, writes that add data are refused: room left to empty the Trash and keep typing. */
export const FULL_AT = 0.9;
/** One note, however it arrives. Bigger than any real note; stops an agent appending forever. */
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const FRESH_MS = 60_000;

export type StorageState = "ok" | "warn" | "full";

let known: { bytes: number; at: number } | null = null;

/** The database's size, measured at most once a minute; writes add to it in between. */
export async function databaseBytes(): Promise<number> {
  if (!known || Date.now() - known.at > FRESH_MS) {
    const [r] = await sql`select pg_database_size(current_database())::bigint as n`;
    known = { bytes: Number(r!.n), at: Date.now() };
  }
  return known.bytes;
}

export async function storageState(): Promise<{ state: StorageState; used: number; limit: number | null }> {
  const limit = settings.dbDiskBytes || null;
  const used = await databaseBytes();
  const share = limit ? used / limit : 0;
  return { state: share >= FULL_AT ? "full" : share >= WARN_AT ? "warn" : "ok", used, limit };
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** Throw 507 if adding `bytes` would take the database past FULL_AT; otherwise count them. */
export async function assertRoom(bytes = 0): Promise<void> {
  const limit = settings.dbDiskBytes;
  if (!limit) return;
  const used = await databaseBytes();
  if (used + bytes > limit * FULL_AT) {
    throw new HttpError(
      507,
      `Storage is nearly full (${mb(used)} of ${mb(limit)}), so nothing new can be added. Empty the Trash or delete large files; an admin can see what's using it in Settings → Admin.`,
    );
  }
  if (known) known.bytes += bytes;
}

/** A note's text must fit MAX_NOTE_BYTES. */
export function assertNoteSize(text: string): void {
  const n = Buffer.byteLength(text);
  if (n > MAX_NOTE_BYTES) throw new HttpError(413, `That note would be ${mb(n)}; a note can be at most ${mb(MAX_NOTE_BYTES)}. Split it, or attach the text as a file.`);
}
