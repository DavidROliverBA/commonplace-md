// A note's earlier versions. Picking one shows what restoring it would change, as a diff against
// the note now, or its full text; restoring keeps the replaced text as a version too.

import { useEffect, useMemo, useState } from "react";
import { api, type Note } from "../lib/api";
import { type DiffLine, lineDiff } from "../lib/diff";
import { relativeTime } from "../lib/links";
import { Diff } from "../ui/Diff";
import { Modal } from "../ui/Modal";
import { toast, toastError } from "../ui/overlays";

/** "Restoring brings back 3 lines and takes away 1", from a diff of now → that version. */
function restoreSummary(d: DiffLine[]): string {
  const back = d.filter((l) => l.kind === "add").length;
  const gone = d.filter((l) => l.kind === "del").length;
  if (!back && !gone) return "Same as the note now";
  const n = (k: number) => `${k} line${k === 1 ? "" : "s"}`;
  return `Restoring ${[back && `brings back ${n(back)}`, gone && `takes away ${n(gone)}`].filter(Boolean).join(" and ")}`;
}

interface Rev {
  id: number;
  created_at: string;
  reason: string;
  author: string | null;
  size: number;
}

export function History({ vaultId, note, readOnly, onClose }: { vaultId: number; note: Note; readOnly: boolean; onClose: () => void }) {
  const [revs, setRevs] = useState<Rev[] | null>(null);
  const [selected, setSelected] = useState<{ id: number; content: string } | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [show, setShow] = useState<"changes" | "text">("changes");
  const changes = useMemo(() => (selected && now !== null ? lineDiff(now, selected.content) : null), [selected, now]);
  const base = `/vaults/${vaultId}/notes/${note.id}/revisions`;

  useEffect(() => {
    api<Rev[]>(base).then(setRevs, (e) => (setRevs([]), toastError(e)));
  }, [note.id]);

  async function pick(id: number) {
    // The note as it is now (it may have changed since History opened), to compare against.
    const [rev, cur] = await Promise.all([api<{ id: number; content: string }>(`${base}/${id}`), api<Note>(`/vaults/${vaultId}/notes/${note.id}`)]);
    setNow(cur.content);
    setSelected(rev);
  }

  // The text being replaced is saved as a version first, so restoring needs no "Are you sure?".
  async function restore() {
    if (!selected) return;
    const rev = revs?.find((r) => r.id === selected.id);
    try {
      await api(`${base}/${selected.id}`, { method: "POST" });
      onClose();
      toast(`Restored the version from ${rev ? relativeTime(rev.created_at) : "history"}. The text it replaced is in history.`);
    } catch (e) {
      toastError(e);
    }
  }
  async function pickSafely(id: number) {
    try {
      await pick(id);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Modal title={`History — ${note.title}`} onClose={onClose} size="wide">
      <div className="history">
        <ul className="history-list">
          {revs === null && <li className="muted">Loading…</li>}
          {revs?.length === 0 && <li className="muted">No earlier versions yet. Snapshots are taken every ten minutes of editing, and before imports and restores.</li>}
          {revs?.map((r) => (
            <li key={r.id}>
              <button className={selected?.id === r.id ? "on" : ""} onClick={() => void pickSafely(r.id)}>
                <span>{new Date(r.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
                <small>
                  {relativeTime(r.created_at)} · {r.author ?? "unknown"} · {r.reason}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <div className="history-preview">
          {selected ? (
            <>
              <div className="history-head">
                <div className="segmented" role="radiogroup" aria-label="Show">
                  <button role="radio" aria-checked={show === "changes"} className={show === "changes" ? "on" : ""} onClick={() => setShow("changes")}>
                    Changes
                  </button>
                  <button role="radio" aria-checked={show === "text"} className={show === "text" ? "on" : ""} onClick={() => setShow("text")}>
                    Full text
                  </button>
                </div>
                {changes && <small className="muted">{restoreSummary(changes)}</small>}
              </div>
              {show === "changes" && changes ? <Diff lines={changes} label="What restoring this version would change" /> : <pre>{selected.content}</pre>}
              {!readOnly && (
                <button className="primary" onClick={restore}>
                  Restore this version
                </button>
              )}
            </>
          ) : (
            <p className="muted">Pick a version to see it.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
