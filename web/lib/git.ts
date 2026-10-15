// A GitHub vault's branch, as the bar and the changes page see it (F14, src/git.ts). One status
// per vault, refetched shortly after notes change, shared by everything that shows it.

import { useEffect, useSyncExternalStore } from "react";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { api } from "./api";

export interface GitChange {
  path: string;
  kind: "added" | "edited" | "deleted" | "moved";
  from?: string;
  note: boolean;
  noteId: number | null;
  unpushed: boolean;
}
export interface GitStatus {
  repo: string;
  folder: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  pushed: boolean;
  pr: { number: number; url: string; state: string } | null;
  changes: GitChange[];
  clashes: { path: string; deletedThere: boolean }[];
  unpushed: number;
  authors: { id: number; name: string; email: string }[];
  mergePending: boolean;
}

const cache = new Map<number, GitStatus>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let version = 0;

/** Refetch a vault's branch status for everything showing it; null if that failed. */
export async function refreshGit(vaultId: number): Promise<GitStatus | null> {
  try {
    const st = await api<GitStatus>(`/vaults/${vaultId}/git`);
    cache.set(vaultId, st);
    version++;
    emit();
    return st;
  } catch {
    return null;
  }
}
/** Put a status the server just sent back (after a push or revert) without another fetch. */
export const setGit = (vaultId: number, st: GitStatus) => (cache.set(vaultId, st), version++, emit());

/** The vault's branch status (null until loaded, or for a vault not from GitHub). Refetched a
 *  moment after `changed` changes (the note list, which moves on every edit in the vault). */
export function useGit(vaultId: number | null, changed: unknown): GitStatus | null {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
  useEffect(() => {
    if (!vaultId) return;
    const t = setTimeout(() => void refreshGit(vaultId), cache.has(vaultId) ? 700 : 0);
    return () => clearTimeout(t);
  }, [vaultId, changed]);
  return vaultId ? (cache.get(vaultId) ?? null) : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "3 notes changed", counting files too. */
export function changedLabel(st: GitStatus): string {
  const notes = st.changes.filter((c) => c.note).length;
  const files = st.changes.length - notes;
  if (!st.changes.length) return `Same as ${st.baseBranch}`;
  return [notes && plural(notes, "note"), files && plural(files, "file")].filter(Boolean).join(" and ") + " changed";
}

/** Bring in what's new on the base branch, then say what changed; clashes wait in Review changes. */
export async function updateFromBase(vaultId: number, st: GitStatus): Promise<void> {
  try {
    const r = await api<{ upToDate: boolean; updated: number; merged: number; added: number; removed: number; clashes: number; kept: number }>(`/vaults/${vaultId}/git/update`, { body: {} });
    await refreshGit(vaultId);
    if (r.upToDate) return toast(`Already up to date with ${st.baseBranch}`);
    const parts = [r.updated + r.merged && `${plural(r.updated + r.merged, "note")} updated`, r.added && `${r.added} new`, r.removed && `${r.removed} removed`].filter(Boolean);
    toast(`${parts.join(", ") || "Up to date"} from ${st.baseBranch}${r.clashes ? `; ${plural(r.clashes, "clash")} to settle in Review changes` : ""}`);
  } catch (e) {
    toastError(e);
  }
}

/** Throw the branch away after a confirm that says what goes; true if it was cancelled. */
export async function cancelBranch(vaultId: number, st: GitStatus): Promise<boolean> {
  const n = st.changes.length;
  const open = st.pr?.state === "open";
  const message = [
    n ? `${plural(n, "change")} go${n === 1 ? "es" : ""} back to what's on ${st.baseBranch}; each note's edits stay in its history.` : "Nothing has changed here.",
    st.pushed && !open ? `The branch ${st.branch} is deleted on GitHub.` : "",
    open ? `Pull request #${st.pr!.number} stays open on GitHub.` : "",
  ].filter(Boolean).join(" ");
  const ok = await confirmDialog({
    title: "Cancel the branch?",
    message,
    action: "Cancel the branch",
    danger: true,
  });
  if (!ok) return false;
  try {
    const r = await api<{ reverted: number; prKept: string | null }>(`/vaults/${vaultId}/git/cancel`, { body: {} });
    await refreshGit(vaultId);
    toast(r.reverted ? `${plural(r.reverted, "change")} undone: back to ${st.baseBranch}` : "Branch cancelled");
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}
