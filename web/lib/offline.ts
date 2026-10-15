// Notes kept on this device for offline use (F4). Each opened note's Yjs state lives in its own
// IndexedDB database (y-indexeddb), named for this server's database and the note, so edits made
// with no signal survive closing the app and merge when it reconnects. The most recently opened
// KEEP notes stay; older ones are dropped. Signing out forgets them all.

import { useEffect, useState } from "react";

const KEEP = 200;
const INDEX = "cp:offline";

type Entry = { db: string; at: number };

function read(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? "{}");
  } catch {
    return {};
  }
}
function write(m: Record<string, Entry>) {
  try {
    localStorage.setItem(INDEX, JSON.stringify(m));
  } catch {}
}

/** The IndexedDB name for a note's offline copy. */
export const offlineName = (instance: string, noteId: number) => `cp-${instance || "local"}-${noteId}`;

/** Record that a note was opened, and drop the oldest copies beyond KEEP. */
export function rememberOpened(db: string) {
  const m = read();
  m[db] = { db, at: Date.now() };
  const all = Object.values(m).sort((a, b) => b.at - a.at);
  for (const old of all.slice(KEEP)) {
    delete m[old.db];
    try {
      indexedDB.deleteDatabase(old.db);
    } catch {}
  }
  write(m);
}

/** Sign out: forget every note kept on this device, and the app's cached reads. */
export async function forgetEverything(): Promise<void> {
  for (const e of Object.values(read())) {
    try {
      indexedDB.deleteDatabase(e.db);
    } catch {}
  }
  write({});
  navigator.serviceWorker?.controller?.postMessage({ type: "forget" });
}

/** Whether the browser thinks it's online, kept up to date. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
