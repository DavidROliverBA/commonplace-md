// Trash: deleted notes, kept with their history for the server's TRASH_DAYS (src/notes.ts), to
// restore or delete forever. Editors see it; only the vault's owner can empty it all at once.

import { useEffect, useState } from "react";
import { api, type Note, type Vault } from "../lib/api";
import { relativeTime } from "../lib/links";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { confirmDialog, toastError } from "../ui/overlays";

interface Item {
  id: number;
  path: string;
  title: string;
  deleted_at: string;
  deleted_by_name: string | null;
}

export function Trash({ vault, onRestored, onClose }: { vault: Vault; onRestored: (note: Note) => void; onClose: () => void }) {
  const [data, setData] = useState<{ days: number; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/vaults/${vault.id}/trash`;
  const load = () => api<{ days: number; items: Item[] }>(base).then(setData, (e) => setError(e.message));
  useEffect(() => void load(), [vault.id]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
  }

  async function deleteForever(t: Item) {
    const yes = await confirmDialog({ title: `Delete “${t.title}” forever?`, message: "It and its history will be gone. This can't be undone.", action: "Delete forever", danger: true });
    if (yes)
      await act(async () => {
        await api(`${base}/${t.id}`, { method: "DELETE" });
        await load();
      });
  }

  async function emptyTrash(count: number) {
    const yes = await confirmDialog({
      title: "Empty Trash?",
      message: `${count === 1 ? "The note" : `All ${count} notes`} in Trash, and ${count === 1 ? "its" : "their"} history, will be gone for every member. This can't be undone.`,
      action: "Empty Trash",
      danger: true,
    });
    if (yes)
      await act(async () => {
        await api(base, { method: "DELETE" });
        await load();
      });
  }

  return (
    <Modal title="Trash" onClose={onClose}>
      <div className="trash">
        <p className="muted small">Deleted notes stay here, with their history, for {data?.days ?? 30} days.</p>
        {error && <div className="error">{error}</div>}
        {data === null && !error && <p className="muted">Loading…</p>}
        {data?.items.length === 0 && <p className="muted">Trash is empty.</p>}
        <ul className="trash-list">
          {data?.items.map((t) => (
            <li key={t.id}>
              <div className="trash-name">
                <span>{t.title}</span>
                <small className="muted">
                  {t.path.includes("/") ? t.path.replace(/\/[^/]+$/, "") + " · " : ""}deleted {relativeTime(t.deleted_at)}
                  {t.deleted_by_name ? ` by ${t.deleted_by_name}` : ""}
                </small>
              </div>
              <button
                onClick={() =>
                  act(async () => {
                    const note = await api<Note>(`${base}/${t.id}/restore`, { method: "POST" });
                    onRestored(note);
                  })
                }
              >
                <Icon name="undo" size={14} /> Restore
              </button>
              <button
                className="danger"
                title="Delete forever"
                aria-label={`Delete ${t.title} forever`}
                onClick={() => void deleteForever(t)}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
        {vault.role === "owner" && !!data?.items.length && (
          <button
            className="danger"
            onClick={() => void emptyTrash(data.items.length)}
          >
            Empty Trash
          </button>
        )}
      </div>
    </Modal>
  );
}
