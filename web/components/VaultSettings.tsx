// Settings → This vault: name, members, import, export, and leave or delete.

import { useEffect, useRef, useState } from "react";
import { api, type Role, type User, type Vault } from "../lib/api";
import { navigate } from "../lib/router";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";

interface Member {
  id: number;
  email: string;
  name: string;
  role: Role;
}

interface Report {
  created: number;
  updated: number;
  skipped: number;
  attachments: number;
  errors: { path: string; error: string }[];
}

export function VaultSettings({ vault, user, onClose, onChanged }: { vault: Vault; user: User; onClose: () => void; onChanged: () => void }) {
  const isOwner = vault.role === "owner";
  const canWrite = vault.role !== "viewer";
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState(vault.name);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [mode, setMode] = useState("overwrite");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const load = () => api<Member[]>(`/vaults/${vault.id}/members`).then(setMembers);
  useEffect(() => {
    void load();
  }, [vault.id]);
  // webkitdirectory isn't in React's typings.
  useEffect(() => dirInput.current?.setAttribute("webkitdirectory", ""), []);

  /** Run an action with a busy label; say when it's done, or what went wrong (principle 6). */
  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  // Removing a member is easy to reverse (add them back with the same role): offer Undo.
  function removeMember(m: Member) {
    void run("Removing…", async () => {
      await api(`/vaults/${vault.id}/members/${m.id}`, { method: "DELETE" });
      await load();
      toast(`Removed ${m.name} from “${vault.name}”`, {
        undo: async () => {
          await api(`/vaults/${vault.id}/members`, { method: "PUT", body: { email: m.email, role: m.role } });
          await load();
        },
      });
    });
  }

  async function leave() {
    const ok = await confirmDialog({
      title: "Leave this vault?",
      message: `You'll lose access to “${vault.name}” until an owner adds you back.`,
      action: "Leave vault",
      danger: true,
    });
    if (!ok) return;
    await run("Leaving…", async () => {
      await api(`/vaults/${vault.id}/members/${user.id}`, { method: "DELETE" });
      onClose();
      navigate("/");
      onChanged();
    }, `You left “${vault.name}”`);
  }

  async function deleteVault() {
    const typed = await promptDialog({
      title: "Delete this vault?",
      message: `This deletes every note in “${vault.name}” for every member, and can't be undone. Type the vault's name to confirm.`,
      label: "Vault name",
      placeholder: vault.name,
      mustMatch: vault.name,
      action: "Delete vault",
      danger: true,
    });
    if (typed !== vault.name) return;
    await run("Deleting…", async () => {
      await api(`/vaults/${vault.id}`, { method: "DELETE" });
      onClose();
      navigate("/");
      onChanged();
    }, `Deleted “${vault.name}”`);
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const form = new FormData();
    for (const f of list) {
      form.append("files", f, f.name);
      form.append("paths", (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    }
    form.append("mode", mode);
    form.append("folder", folder);
    await run("Importing…", async () => {
      setReport(await api<Report>(`/vaults/${vault.id}/import`, { form }));
      onChanged();
    });
    if (filesInput.current) filesInput.current.value = "";
    if (dirInput.current) dirInput.current.value = "";
  }

  return (
    <>
      <section className="settings-section">
        <h3>Vault</h3>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} aria-label="Vault name" />
          {isOwner && (
            <button onClick={() => run("Saving…", () => api(`/vaults/${vault.id}`, { method: "PATCH", body: { name } }).then(onChanged), "Vault renamed")} disabled={!name.trim() || name === vault.name}>
              Rename
            </button>
          )}
        </div>
        <p className="muted">
          Your role: <b>{vault.role}</b>. {vault.note_count} notes.
        </p>
      </section>

      <section className="settings-section">
        <h3>Members</h3>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <div>
                <b>{m.name}</b> <span className="muted">{m.email}</span>
              </div>
              {isOwner && m.id !== user.id ? (
                <div className="row">
                  <select
                    value={m.role}
                    aria-label={`${m.name}'s role`}
                    onChange={(e) => run("Saving…", () => api(`/vaults/${vault.id}/members`, { method: "PUT", body: { email: m.email, role: e.target.value } }).then(load), `${m.name} is now ${e.target.value === "owner" ? "an owner" : `a ${e.target.value}`}`)}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button className="danger-link" onClick={() => removeMember(m)}>
                    Remove
                  </button>
                </div>
              ) : (
                <span className="pill">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void run("Adding…", async () => {
                await api(`/vaults/${vault.id}/members`, { method: "PUT", body: { email, role } });
                setEmail("");
                await load();
                onChanged();
              }, `Added ${email}`);
            }}
          >
            <input type="email" placeholder="Their account email" aria-label="Their account email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Their role">
              <option value="editor">Editor — can edit</option>
              <option value="viewer">Viewer — read only</option>
              <option value="owner">Owner — can manage</option>
            </select>
            <button type="submit">Add member</button>
          </form>
        )}
        <p className="muted">People need an account first: they can sign up (if open), or an admin can create one in Settings → Admin.</p>
      </section>

      {canWrite && (
        <section className="settings-section">
          <h3>Import markdown</h3>
          <p className="muted">An existing vault folder of Markdown files, a .zip of one, or individual .md files. Folder structure, frontmatter, tags, links and attachments come across; app settings folders (dot-folders) are skipped.</p>
          <div className="row wrap">
            <label>
              If a note exists:{" "}
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="overwrite">Overwrite (old text kept in history)</option>
                <option value="skip">Skip it</option>
                <option value="keep-both">Keep both</option>
              </select>
            </label>
            <input placeholder="Into folder (optional)" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </div>
          <div className="row wrap">
            <button onClick={() => dirInput.current?.click()} disabled={!!busy}>
              Choose a folder…
            </button>
            <button onClick={() => filesInput.current?.click()} disabled={!!busy}>
              Choose .md / .zip files…
            </button>
            <input ref={dirInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            <input ref={filesInput} type="file" multiple hidden accept=".md,.markdown,.zip,text/markdown,application/zip,image/*" onChange={(e) => upload(e.target.files)} />
            {busy && <span className="muted">{busy}</span>}
          </div>
          {report && (
            <div className="report">
              Imported: {report.created} new, {report.updated} updated, {report.attachments} attachments, {report.skipped} skipped.
              {report.errors.length > 0 && (
                <details>
                  <summary>{report.errors.length} problems</summary>
                  <ul>
                    {report.errors.map((e) => (
                      <li key={e.path}>
                        {e.path}: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      <section className="settings-section">
        <h3>Export</h3>
        <p className="muted">Everything as plain markdown in a .zip — open it in any Markdown editor.</p>
        <a className="button" href={`/api/vaults/${vault.id}/export`}>
          Download vault (.zip)
        </a>
      </section>

      <section className="settings-section danger-zone">
        <h3>Leave or delete</h3>
        <div className="row wrap">
          <button onClick={() => void leave()}>Leave vault</button>
          {isOwner && (
            <button className="danger" onClick={() => void deleteVault()}>
              Delete vault
            </button>
          )}
        </div>
      </section>
    </>
  );
}
