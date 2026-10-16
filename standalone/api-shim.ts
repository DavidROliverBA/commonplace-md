// Stands in for web/lib/api.ts in the standalone build (build.ts swaps it in): the shared client
// code that reads notes through the server (embeds, types) reads them from the open folder instead.

import { noteFor, VAULT_ID } from "./vault";

export type { Note, NoteSummary, Role, User, Vault, Session } from "../web/lib/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, _opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const note = new RegExp(`^/vaults/${VAULT_ID}/notes/(\\d+)$`).exec(path);
  if (note) {
    const n = noteFor(Number(note[1]));
    if (!n) throw new ApiError(404, "That note isn't in this folder.");
    return n as T;
  }
  // Types (F16) are a server feature; a plain folder has none defined.
  if (path === `/vaults/${VAULT_ID}/types`) return { types: [], undefined: [] } as T;
  throw new ApiError(501, "That needs the Commonplace server.");
}
