// Moving notes and folders, the same way from a drag, the note menu or a folder menu: one
// request, then a toast that can put it back (docs/PRINCIPLES.md §5).

import { chooseDialog, toast, toastError } from "../ui/overlays";
import { api, type Vault } from "./api";
import { navigate, noteUrl } from "./router";
import { allFolders, type DragItem, moveDestinations, moveTarget, nameOf, parentOf } from "./move";

async function send(vaultId: number, item: DragItem, to: string) {
  if (item.kind === "note") await api(`/vaults/${vaultId}/notes/${item.id}`, { method: "PATCH", body: { path: to } });
  else await api(`/vaults/${vaultId}/folders/rename`, { body: { from: item.path, to } });
}

/** Move `item` into `folder` ("" = the vault root). Returns false if nothing moved. */
export async function moveItem(vaultId: number, item: DragItem, folder: string, onChanged: () => void): Promise<boolean> {
  const to = moveTarget(item, folder);
  if (!to) return false;
  try {
    await send(vaultId, item, to);
    onChanged();
    const back = parentOf(item.path);
    const moved: DragItem = item.kind === "note" ? { ...item, path: to } : { kind: "folder", path: to };
    toast(`Moved “${nameOf(item.path).replace(/\.md$/i, "")}” to ${folder || "the top level"}`, {
      undo: async () => {
        await send(vaultId, moved, back ? `${back}/${nameOf(to)}` : nameOf(to));
        onChanged();
      },
    });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** "Move to…": pick a folder from a list, then move. */
export async function moveToPicker(vaultId: number, item: DragItem, folders: string[], onChanged: () => void): Promise<void> {
  const options = moveDestinations(item, folders).map((f) => ({
    value: f || "/",
    label: f ? nameOf(f) : "Top level of the collection",
    hint: f && f.includes("/") ? parentOf(f) : undefined,
    icon: f ? "folder" : "vault",
  }));
  const name = nameOf(item.path).replace(/\.md$/i, "");
  const picked = await chooseDialog({ title: `Move “${name}” to…`, options, placeholder: "Find a folder…", empty: "No folder by that name" });
  if (picked !== null) await moveItem(vaultId, item, picked === "/" ? "" : picked, onChanged);
}

// ── to another vault ──────────────────────────────────────────────────────────────────────
// Copy or move a note or folder into another of your vaults (src/between.ts): pick the vault,
// then the folder there, then a toast that can undo it (the copies to Trash there, and after a
// move the originals back from Trash here).

let myVaults: Vault[] = [];
/** App tells us the vaults once it has them, so the commands know when there's somewhere to send. */
export const setVaultList = (v: Vault[]) => void (myVaults = v);
/** The other vaults you can add notes to. */
export const otherVaults = (fromId: number) => myVaults.filter((v) => v.id !== fromId && v.role !== "viewer");

interface SendReport {
  created: { id: number; path: string; from: string | null }[];
  files: string[];
  trashIds: number[];
}

export async function sendToVault(fromId: number, item: DragItem, move: boolean, onChanged: () => void): Promise<void> {
  const name = nameOf(item.path).replace(/\.md$/i, "");
  const verb = move ? "Move" : "Copy";
  const vaultId = await chooseDialog({
    title: `${verb} “${name}” to…`,
    options: otherVaults(fromId).map((v) => ({ value: String(v.id), label: v.name, hint: v.git_repo ?? undefined, icon: v.git_repo ? "branch" : "vault" })),
    placeholder: "Find a collection…",
    empty: "No other collection you can add to",
  });
  if (vaultId === null) return;
  const to = myVaults.find((v) => v.id === Number(vaultId))!;
  try {
    const [stored, list] = await Promise.all([api<string[]>(`/vaults/${to.id}/folders`), api<{ path: string }[]>(`/vaults/${to.id}/notes`)]);
    const folder = await chooseDialog({
      title: `Into which folder of ${to.name}?`,
      options: ["", ...allFolders(list.map((n) => n.path), stored)].map((f) => ({ value: f || "/", label: f ? nameOf(f) : "Top level of the collection", hint: f && f.includes("/") ? parentOf(f) : undefined, icon: f ? "folder" : "vault" })),
      placeholder: "Find a folder…",
      empty: "No folder by that name",
    });
    if (folder === null) return;
    const r = await api<SendReport>(`/vaults/${fromId}/send`, {
      body: { to: to.id, ...(item.kind === "note" ? { notes: [item.id] } : { folder: item.path }), into: folder === "/" ? "" : folder, move },
    });
    onChanged();
    // A moved note has left this vault: follow it to where it went.
    const moved = r.created.find((c) => c.from);
    if (move && item.kind === "note" && moved) navigate(noteUrl(to.id, moved.id));
    const notes = r.created.filter((c) => c.from).length;
    const files = r.files.length ? `, with ${r.files.length} file${r.files.length === 1 ? "" : "s"}` : "";
    toast(`${move ? "Moved" : "Copied"} ${item.kind === "note" ? `“${name}”` : `${notes} note${notes === 1 ? "" : "s"}`} to ${to.name}${files}`, {
      undo: async () => {
        // Files stay where they landed: nothing removes a file outright.
        for (const c of r.created) await api(`/vaults/${to.id}/notes/${c.id}`, { method: "DELETE" }).catch(() => {});
        const back = [];
        for (const t of r.trashIds) back.push(await api<{ id: number }>(`/vaults/${fromId}/trash/${t}/restore`, { body: {} }));
        onChanged();
        if (move && item.kind === "note" && back[0]) navigate(noteUrl(fromId, back[0].id));
        toast(move ? `Put “${name}” back` : `Removed the copy from ${to.name}`);
      },
    });
  } catch (e) {
    toastError(e);
  }
}
