// Review changes on a GitHub vault (F14): every note and file that differs from the repo
// (added, edited, moved, deleted), each with its diff against what's on GitHub and a Revert, and
// the clashes from an update waiting for a side to be picked. A change can be held back from
// pushes until it's ready (F19).

import { useEffect, useState } from "react";
import { api, type NoteSummary, type Vault } from "../lib/api";
import { lineDiff } from "../lib/diff";
import { changedLabel, type GitChange, type GitStatus, holdChange, refreshGit, sendNow, setGit, useGit } from "../lib/git";
import { navigate, noteUrl } from "../lib/router";
import { Diff } from "../ui/Diff";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { toast, toastError } from "../ui/overlays";

interface Props {
  vault: Vault;
  notes: NoteSummary[];
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  onNavigate: () => void;
  onPullRequest: () => void;
}

const KIND: Record<GitChange["kind"], { label: string; icon: string }> = {
  added: { label: "New", icon: "plus" },
  edited: { label: "Edited", icon: "edit" },
  moved: { label: "Moved", icon: "folder" },
  deleted: { label: "Deleted", icon: "trash" },
};

interface DiffText {
  before: string | null;
  after: string | null;
  theirs?: string | null;
  note: boolean;
}

function ChangeRow({ vault, c, canWrite, pushed, publishing, onOpen }: { vault: Vault; c: GitChange; canWrite: boolean; pushed: boolean; publishing: boolean; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<DiffText | null>(null);
  useEffect(() => {
    if (open && !d) api<DiffText>(`/vaults/${vault.id}/git/diff?path=${encodeURIComponent(c.path)}`).then(setD, toastError);
  }, [open]);
  const k = KIND[c.kind];
  async function revert() {
    try {
      setGit(vault.id, await api<GitStatus>(`/vaults/${vault.id}/git/revert`, { body: { path: c.path } }));
      toast(`${c.path} is back to what's on GitHub`);
    } catch (e) {
      toastError(e);
    }
  }
  const showDiff = c.note && (c.kind === "edited" || c.kind === "added" || c.kind === "deleted");
  return (
    <li className={`change change-${c.kind}`}>
      <div className="change-head">
        <span className="change-kind" title={k.label}>
          <Icon name={k.icon} size={14} /> {k.label}
        </span>
        {c.noteId ? (
          <button className="link change-path" onClick={() => onOpen(c.noteId!)}>
            {c.path}
          </button>
        ) : (
          <span className="change-path">{c.path}</span>
        )}
        {c.from && <span className="muted change-from">from {c.from}</span>}
        {c.held ? (
          <span className="change-held">held back</span>
        ) : publishing && c.kind === "deleted" ? (
          <span className="change-unpushed">waits for Send now</span>
        ) : (
          pushed && c.unpushed && <span className="change-unpushed">not pushed yet</span>
        )}
        <span className="change-actions">
          {canWrite && (
            <button className="quiet" onClick={() => void holdChange(vault.id, c.path, !c.held)} title={c.held ? "Send it with the next push" : "Keep it out of pushes until you release it"}>
              {c.held ? "Release" : "Hold back"}
            </button>
          )}
          {showDiff && (
            <button className="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Hide" : "Diff"}
            </button>
          )}
          {canWrite && (
            <button className="quiet" onClick={() => void revert()}>
              Revert
            </button>
          )}
        </span>
      </div>
      {open && d && <Diff lines={lineDiff(d.before ?? "", d.after ?? "")} label={`Changes to ${c.path}`} />}
    </li>
  );
}

function ClashRow({ vault, path, deletedThere, canWrite, baseBranch }: { vault: Vault; path: string; deletedThere: boolean; canWrite: boolean; baseBranch: string }) {
  const [d, setD] = useState<DiffText | null>(null);
  useEffect(() => void api<DiffText>(`/vaults/${vault.id}/git/diff?path=${encodeURIComponent(path)}`).then(setD, toastError), [path]);
  async function pick(take: "mine" | "theirs") {
    try {
      setGit(vault.id, await api<GitStatus>(`/vaults/${vault.id}/git/resolve`, { body: { path, take } }));
      toast(take === "mine" ? `Kept your ${path}` : `Took ${baseBranch}'s ${path}`);
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <li className="change change-clash">
      <div className="change-head">
        <span className="change-kind">
          <Icon name="branch" size={14} /> Clash
        </span>
        <span className="change-path">{path}</span>
        <span className="muted change-from">{deletedThere ? `deleted on ${baseBranch}, changed here` : d?.after === null ? `changed on ${baseBranch}, deleted here` : `changed here and on ${baseBranch}`}</span>
        {canWrite && (
          <span className="change-actions">
            <button className="quiet" onClick={() => void pick("mine")}>
              Keep mine
            </button>
            <button className="quiet" onClick={() => void pick("theirs")}>
              Take {baseBranch}'s
            </button>
          </span>
        )}
      </div>
      {d && d.theirs !== undefined && (
        <>
          <p className="muted change-note">From yours to {baseBranch}'s:</p>
          <Diff lines={lineDiff(d.after ?? "", d.theirs ?? "")} label={`Yours against ${baseBranch}'s ${path}`} />
        </>
      )}
    </li>
  );
}

export function ChangesPage(p: Props) {
  const st = useGit(p.vault.id, p.notes);
  const canWrite = p.vault.role !== "viewer";
  useEffect(() => void refreshGit(p.vault.id), [p.vault.id]);
  const open = (id: number) => {
    navigate(noteUrl(p.vault.id, id));
    p.onNavigate();
  };

  return (
    <div className="tasks-page changes-page">
      <header className="note-header">
        <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
        <h1 className="note-title type-title">
          <Icon name="branch" /> Changes <span className="count">{st ? changedLabel(st) : ""}</span>
        </h1>
        <div className="note-actions">
          <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
        </div>
      </header>
      <div className="type-body">
        {!st ? (
          <div className="loading-bar" />
        ) : (
          <>
            <p className="muted">
              Against <code>{st.repo}</code>
              {st.folder && (
                <>
                  {" "}
                  / <code>{st.folder}</code>
                </>
              )}{" "}
              on <code>{st.baseBranch}</code>
              {st.pushed && (
                <>
                  ; pushed to <code>{st.branch}</code>
                </>
              )}
              . Code and settings in the repo aren't copied here and are never changed.
            </p>
            {st.clashes.length > 0 && (
              <section className="type-group">
                <h3>
                  To settle <span className="count">{st.clashes.length}</span>
                </h3>
                <ul className="change-list">
                  {st.clashes.map((c) => (
                    <ClashRow key={c.path} vault={p.vault} path={c.path} deletedThere={c.deletedThere} canWrite={canWrite} baseBranch={st.baseBranch} />
                  ))}
                </ul>
              </section>
            )}
            {st.changes.length === 0 ? (
              <p className="muted">Nothing has changed: every note is the same as on {st.baseBranch}.</p>
            ) : (
              <section className="type-group">
                <h3>
                  Changed <span className="count">{st.changes.length}</span>
                </h3>
                <ul className="change-list">
                  {st.changes.map((c) => (
                    <ChangeRow key={c.path} vault={p.vault} c={c} canWrite={canWrite} pushed={st.pushed} publishing={st.auto.mode === "publish"} onOpen={open} />
                  ))}
                </ul>
                {canWrite && st.auto.mode !== "ask" && (st.auto.waiting > 0 || st.auto.deletionsWaiting > 0) && (
                  <button className="primary" onClick={() => void sendNow(p.vault.id, st)} disabled={st.clashes.length > 0}>
                    <Icon name="upload" size={16} /> Send now
                  </button>
                )}
                {canWrite && st.auto.mode === "ask" && (st.unpushed > 0 || !st.pushed) && (
                  <button className="primary" onClick={p.onPullRequest} disabled={st.clashes.length > 0}>
                    <Icon name="pull-request" size={16} /> {st.pushed ? `Push ${st.unpushed} more change${st.unpushed === 1 ? "" : "s"}` : "Open pull request"}
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
