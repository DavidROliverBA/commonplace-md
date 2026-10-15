// Your bookmarks in this vault (F7): starred notes at the top of the sidebar. Kept on the server
// per person, so they follow you between devices.

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { toast, toastError } from "../ui/overlays";

let state: { vaultId: number | null; ids: number[] } = { vaultId: null, ids: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

// The vault the sidebar is showing: a reply for any other (a quick vault switch) is dropped.
let current: number | null = null;

export async function loadBookmarks(vaultId: number) {
  current = vaultId;
  if (state.vaultId !== vaultId) ((state = { vaultId, ids: [] }), emit()); // not the last vault's meanwhile
  const ids = await api<number[]>(`/vaults/${vaultId}/bookmarks`);
  if (vaultId !== current) return;
  state = { vaultId, ids };
  emit();
}
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
const snapshot = () => state;
export const useBookmarks = () => useSyncExternalStore(subscribe, snapshot);
export const isBookmarked = (id: number) => state.ids.includes(id);

export async function toggleBookmark(vaultId: number, noteId: number, title: string) {
  const on = !isBookmarked(noteId);
  try {
    const ids = await api<number[]>(`/vaults/${vaultId}/bookmarks/${noteId}`, { method: on ? "PUT" : "DELETE" });
    if (current === null || vaultId === current) {
      state = { vaultId, ids };
      emit();
    }
    toast(on ? `Bookmarked “${title}”` : `Removed the bookmark`, { undo: () => toggleBookmark(vaultId, noteId, title) });
  } catch (e) {
    toastError(e);
  }
}
