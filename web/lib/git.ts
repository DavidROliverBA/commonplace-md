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
  /** Held back from pushes until released (F19). */
  held: boolean;
}

export type SendMode = "ask" | "review" | "sync" | "publish";

/** How a vault's changes go to GitHub (F19, src/gitAuto.ts). */
export interface AutoStatus {
  mode: SendMode;
  every: "hour" | "day" | "week";
  at: string;
  day: number;
  soon: boolean;
  coauthorEmails: boolean;
  sendAs: { id: number; name: string } | null;
  paused: { by: "person" | "clashes" | "sender" | "github"; message: string } | null;
  nextRunAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  waiting: number;
  deletionsWaiting: number;
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
  held: number;
  auto: AutoStatus;
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

// ── sending on its own (F19) ─────────────────────────────────────────────────────────────

export const MODES: { id: SendMode; label: string; help: string }[] = [
  { id: "ask", label: "Ask me", help: "Nothing is sent until you press Open pull request, or push more to it." },
  { id: "review", label: "Regular review", help: "One pull request every hour, day or week. Changes join the open one until it's merged." },
  { id: "sync", label: "Keep a branch in sync", help: "Each note goes to the working branch once nobody has typed in it for a couple of minutes. You open the pull request when you choose." },
  { id: "publish", label: "Publish straight to a branch", help: "No pull request: changes go onto the branch itself, main included, on a schedule or soon after edits." },
];

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "18:00", or "Fri 18:00" when it isn't today, in UK time. */
function when(iso: string): string {
  const d = new Date(iso);
  const uk = (o: Intl.DateTimeFormatOptions, t: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", ...o }).format(t);
  const time = uk({ hour: "2-digit", minute: "2-digit" }, d);
  return uk({ dateStyle: "short" }, d) === uk({ dateStyle: "short" }, new Date()) ? time : `${uk({ weekday: "short" }, d)} ${time}`;
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - +new Date(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : when(iso);
}

/** The branch bar's line about automatic pushes: what's next, what's waiting, who sends. */
export function autoLine(st: GitStatus): string | null {
  const a = st.auto;
  if (a.mode === "ask") return null;
  if (a.paused) return a.paused.message;
  const waiting = a.waiting ? plural(a.waiting, "change") + " waiting" : "";
  const target = a.mode === "publish" ? st.baseBranch : st.pr?.state === "open" ? `#${st.pr.number}` : null;
  let next = "";
  if (a.mode === "review" || (a.mode === "publish" && !a.soon)) {
    if (a.nextRunAt) next = `${a.mode === "publish" ? `Next publish to ${target}` : target ? `Next push to ${target}` : "Next PR"} at ${when(a.nextRunAt)}`;
  } else if (a.waiting) next = a.mode === "publish" ? `Publishing to ${target} once edits pause` : "Pushing once edits pause";
  else if (a.lastSentAt) next = `${a.mode === "publish" ? "Published" : "Pushed"} ${ago(a.lastSentAt)}`;
  else next = a.mode === "publish" ? `Publishes to ${target} soon after edits` : "Pushes soon after edits";
  const parts = [next, waiting, a.deletionsWaiting ? `${plural(a.deletionsWaiting, "deletion")} wait${a.deletionsWaiting === 1 ? "s" : ""} for you` : "", a.lastError ? "last try failed, trying again" : "", a.sendAs ? `sends as ${a.sendAs.name}` : ""];
  return parts.filter(Boolean).join(" · ");
}

/** Send now: as you, deletions included (after a confirm that names them). */
export async function sendNow(vaultId: number, st: GitStatus): Promise<void> {
  const deletions = st.changes.filter((c) => c.kind === "deleted" && !c.held);
  if (st.auto.mode === "publish" && deletions.length) {
    const names = deletions.map((c) => c.path).slice(0, 5).join(", ") + (deletions.length > 5 ? "…" : "");
    const ok = await confirmDialog({ title: `Delete ${plural(deletions.length, "note")} on ${st.baseBranch}?`, message: `${names} ${deletions.length === 1 ? "goes" : "go"} from ${st.repo} along with the other changes. Hold a deletion back in Review changes to keep it waiting.`, action: "Send now", danger: true });
    if (!ok) return;
  }
  try {
    const next = await api<GitStatus>(`/vaults/${vaultId}/git/send-now`, { body: {} });
    setGit(vaultId, next);
    toast(st.auto.mode === "publish" ? `Published to ${next.baseBranch}` : next.pr ? `Sent to pull request #${next.pr.number}` : `Sent to ${next.branch}`);
  } catch (e) {
    toastError(e);
    void refreshGit(vaultId);
  }
}

export async function setPaused(vaultId: number, paused: boolean): Promise<void> {
  try {
    setGit(vaultId, await api<GitStatus>(`/vaults/${vaultId}/git/pause`, { body: { paused } }));
    toast(paused ? "Automatic pushes paused" : "Automatic pushes carry on");
  } catch (e) {
    toastError(e);
  }
}

/** Hold a change back from pushes, or let it go with the next one. */
export async function holdChange(vaultId: number, path: string, held: boolean): Promise<void> {
  try {
    setGit(vaultId, await api<GitStatus>(`/vaults/${vaultId}/git/hold`, { body: { path, held } }));
    toast(held ? `${path} is held back` : `${path} goes with the next push`);
  } catch (e) {
    toastError(e);
  }
}
