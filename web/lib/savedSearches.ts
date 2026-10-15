// Saved searches: a search kept in the sidebar under Bookmarks, run afresh whenever it's opened,
// so it works as a smart folder. Kept on the server per person, like bookmarks.

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { toast, toastError } from "../ui/overlays";

export interface SavedSearch {
  id: number;
  query: string;
}

let state: { vaultId: number | null; list: SavedSearch[] } = { vaultId: null, list: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const set = (vaultId: number, list: SavedSearch[]) => ((state = { vaultId, list }), emit());

export async function loadSavedSearches(vaultId: number) {
  set(vaultId, await api<SavedSearch[]>(`/vaults/${vaultId}/searches`));
}
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const useSavedSearches = () => useSyncExternalStore(subscribe, () => state);
export const savedFor = (query: string) => state.list.find((s) => s.query === query.trim()) ?? null;

export async function saveSearch(vaultId: number, query: string) {
  try {
    set(vaultId, await api<SavedSearch[]>(`/vaults/${vaultId}/searches`, { body: { query } }));
    const saved = savedFor(query);
    toast(`Saved “${query.trim()}” in the sidebar`, saved ? { undo: () => removeSearch(vaultId, saved, false) } : {});
  } catch (e) {
    toastError(e);
  }
}

export async function removeSearch(vaultId: number, s: SavedSearch, offerUndo = true) {
  try {
    set(vaultId, await api<SavedSearch[]>(`/vaults/${vaultId}/searches/${s.id}`, { method: "DELETE" }));
    if (offerUndo) toast(`Removed the saved search`, { undo: () => saveSearch(vaultId, s.query) });
  } catch (e) {
    toastError(e);
  }
}
