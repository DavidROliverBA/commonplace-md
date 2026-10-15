// The vault's types (F16), loaded with its notes and shared by the sidebar, the type chip, the
// properties panel, type pages and the command list. Module state, like the command registry,
// so CodeMirror's properties widget (outside React) can read it too.

import { useSyncExternalStore } from "react";
import { normalisePath } from "../../src/markdown";
import { newTypedNote, newTypeNote, type TypeDef, TYPES_FOLDER } from "../../src/types";
import { api, type Note } from "./api";
import { fillTemplate } from "./templates";

export type { TypeDef, TypeProp } from "../../src/types";

interface State {
  vaultId: number | null;
  types: TypeDef[];
  undefined: { name: string; count: number }[];
}
let state: State = { vaultId: null, types: [], undefined: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** Fetch the vault's types, and the type names notes use that have no definition yet. */
export async function loadTypes(vaultId: number): Promise<void> {
  const r = await api<{ types: TypeDef[]; undefined: { name: string; count: number }[] }>(`/vaults/${vaultId}/types`);
  state = { vaultId, types: r.types, undefined: r.undefined };
  emit();
}
export const typesState = () => state;
export function subscribeTypes(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export const useTypes = () => useSyncExternalStore(subscribeTypes, typesState);

export const typeNamed = (name: string | null | undefined): TypeDef | null =>
  name ? (state.types.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null) : null;

export const typeUrl = (vaultId: number, name: string) => `/v/${vaultId}/t/${encodeURIComponent(name)}`;

/** Make a note of a type: its `type:` line and the type's template, filled in. */
export async function createTypedNote(vaultId: number, type: TypeDef, title: string, folder?: string): Promise<Note> {
  const def = await api<Note>(`/vaults/${vaultId}/notes/${type.noteId}`);
  const body = def.content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const content = newTypedNote(type, fillTemplate(body, { title, date: new Date() }));
  return api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(folder ? `${folder}/${title}` : title), content } });
}

/** Make a type: a note in Types/ with a starter property, then the vault's types reload. */
export async function createType(vaultId: number, name: string): Promise<Note> {
  const n = await api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(`${TYPES_FOLDER}/${name}`), content: newTypeNote(name) } });
  await loadTypes(vaultId);
  return n;
}

/** Set some of a note's properties (null removes one), live-safe. */
export const setProperties = (vaultId: number, noteId: number, set: Record<string, unknown>) =>
  api<Note>(`/vaults/${vaultId}/notes/${noteId}/properties`, { method: "PATCH", body: { set } });
