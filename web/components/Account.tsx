// Settings → Account (profile, password, sign out) and Settings → Admin (storage, accounts).

import { useEffect, useState } from "react";
import { api, type User } from "../lib/api";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { forgetEverything } from "../lib/offline";

interface Storage {
  database: number;
  attachments: number;
  notes: number;
  revisions: number;
  trash: number;
  limit: number | null;
  /** Shares of the limit: past warnAt admins are told; past fullAt new data is refused. */
  warnAt: number;
  fullAt: number;
}
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

interface AdminUser extends User {
  created_at: string;
}

async function attempt(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    toast(ok);
  } catch (e) {
    toastError(e);
  }
}

export function AccountSettings({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  return (
    <>
      <section className="settings-section">
        <h3>Profile</h3>
        <p className="muted">{user.email}</p>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
          <button onClick={() => attempt(() => api("/me", { method: "PATCH", body: { name } }).then(onChanged), "Name saved")} disabled={!name.trim() || name === user.name}>
            Save name
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h3>Password</h3>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(async () => {
              await api("/me", { method: "PATCH", body: { currentPassword: cur, newPassword: next } });
              setCur("");
              setNext("");
            }, "Password changed");
          }}
        >
          <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          <input type="password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          <button type="submit">Change password</button>
        </form>
      </section>
      <section className="settings-section">
        <button
          className="danger"
          onClick={() =>
            api("/logout", { method: "POST" }).then(async () => {
              await forgetEverything(); // notes kept on this device for offline go too
              location.href = "/";
            }, toastError)
          }
        >
          Sign out
        </button>
      </section>
    </>
  );
}

export function AdminSettings({ user }: { user: User }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nu, setNu] = useState({ email: "", name: "", password: "", is_admin: false });
  const [storage, setStorage] = useState<Storage | null>(null);

  const loadUsers = async () => setUsers(await api<AdminUser[]>("/admin/users"));
  useEffect(() => {
    loadUsers().catch(toastError);
    api<Storage>("/admin/storage").then(setStorage, () => {});
  }, []);

  async function deleteUser(u: AdminUser) {
    const yes = await confirmDialog({
      title: `Delete ${u.name}'s account?`,
      message: `${u.email} won't be able to sign in. Vaults only they own pass to you. This can't be undone.`,
      action: "Delete account",
      danger: true,
    });
    if (yes) await attempt(() => api(`/admin/users/${u.id}`, { method: "DELETE" }).then(loadUsers), `Deleted ${u.email}`);
  }

  return (
    <>
      {storage && (
        <section className="settings-section">
          <h3>Storage</h3>
          <p>
            <b>{mb(storage.database)}</b> used{storage.limit ? ` of ${mb(storage.limit)} (${Math.round((storage.database / storage.limit) * 100)}%)` : ""}
          </p>
          {storage.limit && <div className={`meter${storage.database / storage.limit > storage.warnAt ? " warn" : ""}`}><span style={{ width: `${Math.min(100, (storage.database / storage.limit) * 100)}%` }} /></div>}
          <p className="muted small">
            Pictures and files {mb(storage.attachments)} · notes {mb(storage.notes)} · history {mb(storage.revisions)} · Trash {mb(storage.trash)}
          </p>
          {storage.limit && (
            <p className="muted small">
              At {Math.round(storage.fullAt * 100)}% ({mb(storage.limit * storage.fullAt)}) nothing new can be added until space is freed, so the database never fills and stops. Typing in open notes carries on.
            </p>
          )}
        </section>
      )}

      <section className="settings-section">
        <h3>Accounts</h3>
        <ul className="members">
          {users.map((u) => (
            <li key={u.id}>
              <div>
                <b>{u.name}</b> <span className="muted">{u.email}</span> {u.is_admin && <span className="pill">admin</span>}
              </div>
              {u.id !== user.id && (
                <button className="danger-link" onClick={() => void deleteUser(u)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(async () => {
              await api("/admin/users", { body: nu });
              setNu({ email: "", name: "", password: "", is_admin: false });
              await loadUsers();
            }, "Account created — share the password with them; they can change it in Settings → Account.");
          }}
        >
          <input type="email" placeholder="Email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required />
          <input placeholder="Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
          <input type="text" placeholder="Temporary password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} minLength={8} required />
          <label className="check">
            <input type="checkbox" checked={nu.is_admin} onChange={(e) => setNu({ ...nu, is_admin: e.target.checked })} /> Admin
          </label>
          <button type="submit">Create account</button>
        </form>
      </section>
    </>
  );
}
