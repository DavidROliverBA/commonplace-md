// Invitations waiting for you (N13): shown above the vault switcher, only when there are some.
// Nobody joins a vault without saying yes here: Accept makes you a member with the invited role
// and opens the vault; Decline drops the invitation (the owner can invite you again).

import { useEffect, useState } from "react";
import { api, type Role, type Vault } from "../lib/api";
import { navigate } from "../lib/router";
import { toast, toastError } from "../ui/overlays";

interface Invitation {
  id: number;
  vault_id: number;
  vault_name: string;
  role: Role;
  invited_by: string;
}

const AS: Record<Role, string> = { owner: "an owner", editor: "an editor", viewer: "a viewer" };

export function Invitations({ onJoined }: { onJoined: () => unknown }) {
  const [list, setList] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    const load = () => api<Invitation[]>("/invitations").then(setList, () => {});
    void load();
    // Pick up an invitation sent while the app was in the background.
    const onFocus = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, []);

  if (!list.length) return null;

  async function answer(i: Invitation, accept: boolean) {
    setBusy(i.id);
    try {
      if (accept) {
        const v = await api<Vault>(`/invitations/${i.id}/accept`, { method: "POST" });
        await onJoined();
        navigate(`/v/${v.id}`);
        toast(`You joined “${i.vault_name}”`);
      } else {
        await api(`/invitations/${i.id}`, { method: "DELETE" });
        toast(`Declined “${i.vault_name}”. ${i.invited_by} can invite you again.`);
      }
      setList((l) => l.filter((x) => x.id !== i.id));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="invitations" aria-label="Invitations">
      {list.map((i) => (
        <li key={i.id}>
          <p>
            <b>{i.invited_by}</b> invited you to <b>{i.vault_name}</b> as {AS[i.role]}.
          </p>
          <div className="row">
            <button className="primary" disabled={busy === i.id} onClick={() => answer(i, true)}>
              Join collection
            </button>
            <button disabled={busy === i.id} onClick={() => answer(i, false)}>
              Decline
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
