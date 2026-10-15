// Vaults and membership. Roles: owner (manage members, delete vault), editor (write notes),
// viewer (read only — enforced in the API and in the live-collaboration socket).

import { HttpError, type User } from "./auth";
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

/** Add an existing user by email, or change their role if already a member. */
export async function setMember(vaultId: number, email: string, role: Role): Promise<void> {
  if (!(role in RANK)) throw new HttpError(400, "Unknown role");
  const [u] = await sql`select id from users where email = ${email.trim().toLowerCase()}`;
  if (!u) throw new HttpError(404, "No account with that email. An admin can create one, or they can sign up.");
  await sql.begin(async (tx) => {
    await tx`
      insert into vault_members (vault_id, user_id, role) values (${vaultId}, ${u.id}, ${role})
      on conflict (vault_id, user_id) do update set role = excluded.role`;
    await assertHasOwner(tx, vaultId);
  });
}

export async function removeMember(vaultId: number, userId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from vault_members where vault_id = ${vaultId} and user_id = ${userId}`;
    await assertHasOwner(tx, vaultId);
  });
}

async function assertHasOwner(tx: any, vaultId: number) {
  const [{ n }] = await tx`select count(*)::int as n from vault_members where vault_id = ${vaultId} and role = 'owner'`;
  if (n === 0) throw new HttpError(400, "A vault must keep at least one owner");
}
