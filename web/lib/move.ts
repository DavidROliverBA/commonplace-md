// Where a dragged note or folder lands when dropped on a folder ("" = the vault root).

export type DragItem = { kind: "note"; id: number; path: string } | { kind: "folder"; path: string };

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The item's new path, or null when the drop would do nothing or is impossible. */
export function moveTarget(item: DragItem, folder: string): string | null {
  const lower = folder.toLowerCase();
  if (parentOf(item.path).toLowerCase() === lower) return null; // already there
  if (item.kind === "folder") {
    const self = item.path.toLowerCase();
    if (lower === self || lower.startsWith(self + "/")) return null; // into itself
  }
  return folder ? `${folder}/${nameOf(item.path)}` : nameOf(item.path);
}

/** Every folder in the vault: stored ones (empty folders) and those implied by note paths. */
export function allFolders(notePaths: string[], stored: string[]): string[] {
  const seen = new Map<string, string>();
  const add = (f: string) => {
    const parts = f.split("/");
    parts.forEach((_, i) => {
      const p = parts.slice(0, i + 1).join("/");
      if (p && !seen.has(p.toLowerCase())) seen.set(p.toLowerCase(), p);
    });
  };
  stored.forEach(add);
  notePaths.forEach((p) => p.includes("/") && add(parentOf(p)));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The folders `item` can move to (the root is ""), leaving out where it is and itself. */
export function moveDestinations(item: DragItem, folders: string[]): string[] {
  return ["", ...folders].filter((f) => moveTarget(item, f) !== null);
}

export { nameOf, parentOf };
