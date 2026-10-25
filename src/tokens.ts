// Bearer tokens for clients that aren't the browser (docs/PRINCIPLES.md §10). Per person,
// revocable, shown once and stored only as SHA-256 hashes, and always sent in an
// `Authorization: Bearer` header, never in a URL. Two kinds today:
//   capture (cpc_…): the iPhone Shortcut; can only append to one note in one vault (src/capture.ts)
//   mcp (cpm_…):     Claude and other agents over MCP (src/mcp.ts); every vault the person can
//                    see, read-only ("mcp:read") or read and write ("mcp")

import { randomBytes } from "node:crypto";
import { hashToken, HttpError, type User } from "./auth";
import { sql } from "./db";
import { normalisePath } from "./markdown";
import * as vaults from "./vaults";

export type Kind = "capture" | "mcp";
const PREFIX: Record<Kind, string> = { capture: "cpc_", mcp: "cpm_" };
const SCOPES: Record<Kind, string[]> = { capture: ["capture"], mcp: ["mcp", "mcp:read"] };

export interface ApiToken {
  id: number;
  name: string;
  scope: string;
  vault_id: number | null;
  vault_name: string | null;
  note_path: string | null;
  created_at: string;
  last_used_at: string | null;
}

export async function listTokens(userId: number): Promise<ApiToken[]> {
  return sql<ApiToken[]>`
    select t.id, t.name, t.scope, t.vault_id, v.name as vault_name, case when t.scope = 'capture' then t.note_path end as note_path,
           t.created_at, t.last_used_at
    from api_tokens t left join vaults v on v.id = t.vault_id
    where t.user_id = ${userId} order by t.created_at`;
}

/** Make a token. Its value is returned this once and never stored. */
export async function createToken(
  user: User,
  input: { kind: Kind; name: string; vaultId?: number; notePath?: string; readOnly?: boolean },
): Promise<{ token: string; row: ApiToken }> {
  let vaultId: number | null = null;
  let notePath = "Inbox.md";
  let scope = "capture";
  if (input.kind === "capture") {
    if (!input.vaultId) throw new HttpError(400, "Choose a collection for the capture token");
    await vaults.requireRole(input.vaultId, user, "editor");
    vaultId = input.vaultId;
    notePath = normalisePath(input.notePath?.trim() || "Inbox");
  } else scope = input.readOnly ? "mcp:read" : "mcp";
  const token = PREFIX[input.kind] + randomBytes(32).toString("base64url");
  const fallback = input.kind === "capture" ? "iPhone" : "Claude";
  const [r] = await sql`
    insert into api_tokens (user_id, vault_id, name, scope, token_hash, note_path)
    values (${user.id}, ${vaultId}, ${input.name.trim() || fallback}, ${scope}, ${hashToken(token)}, ${notePath})
    returning id`;
  return { token, row: (await listTokens(user.id)).find((t) => t.id === Number(r!.id))! };
}

export async function revokeToken(userId: number, id: number): Promise<void> {
  const r = await sql`delete from api_tokens where id = ${id} and user_id = ${userId} returning id`;
  if (!r.length) throw new HttpError(404, "Token not found");
}

/** Who a request's bearer token belongs to, for one kind of token; 401 otherwise. */
export async function authenticateToken(req: Request, kind: Kind) {
  const label = kind === "capture" ? "capture" : "MCP";
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!given.startsWith(PREFIX[kind])) throw new HttpError(401, `Add your ${label} token as an Authorization: Bearer header`);
  const [t] = await sql`
    update api_tokens set last_used_at = now()
    where token_hash = ${hashToken(given)} and scope = any(${SCOPES[kind]})
    returning id, user_id, vault_id, note_path, scope`;
  if (!t) throw new HttpError(401, `This ${label} token isn't valid. It may have been revoked; make a new one in Settings → Connections.`);
  const [user] = await sql<User[]>`select id, email, name, is_admin from users where id = ${t.user_id}`;
  return { user: user!, scope: t.scope as string, vaultId: t.vault_id === null ? null : Number(t.vault_id), notePath: t.note_path as string };
}
