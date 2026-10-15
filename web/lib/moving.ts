// Moving notes and folders, the same way from a drag, the note menu or a folder menu: one
// request, then a toast that can put it back (docs/PRINCIPLES.md §5).

import { chooseDialog, toast, toastError } from "../ui/overlays";
import { api } from "./api";
import { type DragItem, moveDestinations, moveTarget, nameOf, parentOf } from "./move";

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
    label: f ? nameOf(f) : "Top level of the vault",
    hint: f && f.includes("/") ? parentOf(f) : undefined,
    icon: f ? "folder" : "vault",
  }));
  const name = nameOf(item.path).replace(/\.md$/i, "");
  const picked = await chooseDialog({ title: `Move “${name}” to…`, options, placeholder: "Find a folder…", empty: "No folder by that name" });
  if (picked !== null) await moveItem(vaultId, item, picked === "/" ? "" : picked, onChanged);
}
