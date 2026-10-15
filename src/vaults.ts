// Vaults and membership. Roles: owner (manage members, delete vault), editor (write notes),
// viewer (read only — enforced in the API and in the live-collaboration socket). Every access
// check reads vault_members; invitations (vault_invites) grant nothing until accepted.

import { HttpError, type User, validateEmail } from "./auth";
import { sql } from "./db";

export type Role = "owner" | "editor" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export interface Vault {
  id: number;
  name: string;
  role: Role;
  note_count: number;
  member_count: number;
  /** "owner/name" when the vault is a copy of a GitHub repo (F14). */
  git_repo?: string | null;
}

export async function listVaults(userId: number): Promise<Vault[]> {
  return sql<Vault[]>`
    select v.id, v.name, m.role,
      (select count(*)::int from notes n where n.vault_id = v.id) as note_count,
      (select count(*)::int from vault_members mm where mm.vault_id = v.id) as member_count,
      (select g.repo from vault_git g where g.vault_id = v.id) as git_repo
    from vaults v join vault_members m on m.vault_id = v.id and m.user_id = ${userId}
    order by v.name`;
}

export async function createVault(user: User, name: string): Promise<Vault> {
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "Vault name is required");
  return sql.begin(async (tx) => {
    const [v] = await tx`insert into vaults (name, created_by) values (${clean}, ${user.id}) returning id, name`;
    await tx`insert into vault_members (vault_id, user_id, role) values (${v!.id}, ${user.id}, 'owner')`;
    return { id: v!.id, name: v!.name, role: "owner" as Role, note_count: 0, member_count: 1 };
  });
}

/** The caller's role in the vault, or a 404 (not 403: don't confirm a vault exists). */
export async function roleIn(vaultId: number, userId: number): Promise<Role> {
  const [m] = await sql`select role from vault_members where vault_id = ${vaultId} and user_id = ${userId}`;
  if (!m) throw new HttpError(404, "Vault not found");
  return m.role as Role;
}

/** The caller's role, if it is at least `min`: 404 for a non-member, 403 when it's too low. */
export async function requireRole(vaultId: number, user: User, min: Role): Promise<Role> {
  const role = await roleIn(vaultId, user.id);
  if (RANK[role] < RANK[min]) throw new HttpError(403, min === "editor" ? "This vault is read-only for you" : "Only a vault owner can do that");
  return role;
}

export const canWrite = (role: Role) => RANK[role] >= RANK.editor;

export async function renameVault(vaultId: number, name: string): Promise<void> {
  if (!name.trim()) throw new HttpError(400, "Vault name is required");
  await sql`update vaults set name = ${name.trim()} where id = ${vaultId}`;
}

export async function deleteVault(vaultId: number): Promise<void> {
  await sql`delete from vaults where id = ${vaultId}`;
}

export async function listMembers(vaultId: number) {
  return sql`
    select u.id, u.email, u.name, m.role, m.added_at
    from vault_members m join users u on u.id = m.user_id
    where m.vault_id = ${vaultId}
    order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, u.name`;
}

/**
 * Invite someone by email, or change their role if they're already a member (N13). Nobody joins a
 * vault without accepting: a non-member gets a pending invitation, stored by email whether or not
 * the account exists, so the reply is the same either way and doesn't reveal who has an account.
 * Inviting the same email again just changes the invited role.
 */
export async function setMember(vaultId: number, email: string, role: Role, invitedBy: User): Promise<{ status: "updated"; userId: number } | { status: "invited" }> {
  if (!(role in RANK)) throw new HttpError(400, "Unknown role");
  const clean = validateEmail(email);
  return sql.begin(async (tx) => {
    const [m] = await tx`
      select m.user_id from vault_members m join users u on u.id = m.user_id
      where m.vault_id = ${vaultId} and u.email = ${clean}`;
    if (m) {
      await tx`update vault_members set role = ${role} where vault_id = ${vaultId} and user_id = ${m.user_id}`;
      await assertHasOwner(tx, vaultId);
      return { status: "updated" as const, userId: Number(m.user_id) };
    }
    await tx`
      insert into vault_invites (vault_id, email, role, invited_by) values (${vaultId}, ${clean}, ${role}, ${invitedBy.id})
      on conflict (vault_id, email) do update set role = excluded.role, invited_by = excluded.invited_by`;
    return { status: "invited" as const };
  });
}

// An invitation is open while whoever sent it is still an owner of the vault: removing or
// demoting an owner withdraws what they sent.

/** The vault's pending invitations, for its owners. */
export async function listInvites(vaultId: number) {
  return sql`
    select i.id, i.email, i.role, i.created_at, u.name as invited_by
    from vault_invites i join users u on u.id = i.invited_by
    where i.vault_id = ${vaultId} and exists (select 1 from vault_members o where o.vault_id = i.vault_id and o.user_id = i.invited_by and o.role = 'owner')
    order by i.created_at`;
}

export async function cancelInvite(vaultId: number, inviteId: number): Promise<void> {
  const r = await sql`delete from vault_invites where id = ${inviteId} and vault_id = ${vaultId}`;
  if (r.count === 0) throw new HttpError(404, "That invitation is no longer open");
}

/** Invitations waiting for this person: the only vault detail they see before accepting is its name. */
export async function myInvites(user: User) {
  return sql`
    select i.id, i.vault_id, v.name as vault_name, i.role, u.name as invited_by, i.created_at
    from vault_invites i join vaults v on v.id = i.vault_id join users u on u.id = i.invited_by
    where i.email = ${user.email.toLowerCase()} and exists (select 1 from vault_members o where o.vault_id = i.vault_id and o.user_id = i.invited_by and o.role = 'owner')
    order by i.created_at`;
}

/** Accept: the only way into a vault someone else made. Returns the vault, now in their list. */
export async function acceptInvite(user: User, inviteId: number): Promise<Vault> {
  const vaultId = await sql.begin(async (tx) => {
    const [i] = await tx`
      delete from vault_invites i where i.id = ${inviteId} and i.email = ${user.email.toLowerCase()} and exists (select 1 from vault_members o where o.vault_id = i.vault_id and o.user_id = i.invited_by and o.role = 'owner')
      returning i.vault_id, i.role`;
    if (!i) throw new HttpError(404, "That invitation is no longer open");
    // Already a member (added some other way meanwhile): keep the role they have.
    await tx`insert into vault_members (vault_id, user_id, role) values (${i.vault_id}, ${user.id}, ${i.role}) on conflict (vault_id, user_id) do nothing`;
    return Number(i.vault_id);
  });
  return (await listVaults(user.id)).find((v) => v.id === vaultId)!;
}

export async function declineInvite(user: User, inviteId: number): Promise<void> {
  const r = await sql`delete from vault_invites where id = ${inviteId} and email = ${user.email.toLowerCase()}`;
  if (r.count === 0) throw new HttpError(404, "That invitation is no longer open");
}

// Undo for "Remove member": an owner who removed someone can put them back, with the same role,
// for a few minutes. Only a removal by an owner counts; someone who left needs a new invitation.
const UNDO_MS = 5 * 60_000;
const removed = new Map<string, { role: Role; by: number; at: number }>();

export async function removeMember(vaultId: number, userId: number, by?: User): Promise<void> {
  const role = await sql.begin(async (tx) => {
    const [m] = await tx`delete from vault_members where vault_id = ${vaultId} and user_id = ${userId} returning role`;
    await assertHasOwner(tx, vaultId);
    return m?.role as Role | undefined;
  });
  if (role && by && by.id !== userId) {
    const now = Date.now();
    for (const [k, r] of removed) if (now - r.at > UNDO_MS) removed.delete(k);
    removed.set(`${vaultId}:${userId}`, { role, by: by.id, at: now });
  }
}

/** Undo a removal just made by this owner. 404 when there's nothing recent to undo. */
export async function restoreMember(vaultId: number, userId: number, by: User): Promise<void> {
  const key = `${vaultId}:${userId}`;
  const r = removed.get(key);
  if (!r || r.by !== by.id || Date.now() - r.at > UNDO_MS) throw new HttpError(404, "It's too late to undo that. Invite them again instead.");
  removed.delete(key);
  await sql`insert into vault_members (vault_id, user_id, role) values (${vaultId}, ${userId}, ${r.role}) on conflict (vault_id, user_id) do nothing`;
}

async function assertHasOwner(tx: any, vaultId: number) {
  const [{ n }] = await tx`select count(*)::int as n from vault_members where vault_id = ${vaultId} and role = 'owner'`;
  if (n === 0) throw new HttpError(400, "A vault must keep at least one owner");
}
