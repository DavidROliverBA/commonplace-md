// Environment, read once. Bun loads .env automatically.

import { randomBytes } from "node:crypto";

export type EmbeddingProvider = "relaxai" | "voyage" | "ollama" | "hash" | "none";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** Production booted without SETUP_TOKEN: a random one, which server.ts prints while there are no
 *  accounts, so a fresh public deploy can't be claimed by whoever finds it first. */
export const generatedSetupToken = process.env.SETUP_TOKEN === undefined && process.env.NODE_ENV === "production" ? randomBytes(18).toString("base64url") : "";

export const settings = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace",
  port: Number(process.env.PORT ?? 3000),
  /** Off unless set: the first account is always allowed, and after that an admin adds people. */
  allowSignup: bool(process.env.ALLOW_SIGNUP, false),
  /** When set, GET /api/backup with `Authorization: Bearer <token>` returns every vault as a zip. */
  backupToken: process.env.BACKUP_TOKEN?.trim() ?? "",
  /** When set, creating the first (admin) account requires this token (generated in production
   *  when unset, above; set it empty to turn the check off). */
  setupToken: process.env.SETUP_TOKEN?.trim() ?? generatedSetupToken,
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "hash") as EmbeddingProvider,
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  /** relaxAI (Civo, UK): the server's own key, for embeddings only. People's assistants use
   *  their own keys (src/assistants.ts). */
  relaxApiKey: process.env.RELAX_API_KEY?.trim() ?? "",
  relaxBaseUrl: (process.env.RELAX_BASE_URL?.trim() || "https://api.relax.ai/v1").replace(/\/+$/, ""),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  /** undefined = decide per request from the protocol (x-forwarded-proto aware). */
  cookieSecure: process.env.COOKIE_SECURE ? bool(process.env.COOKIE_SECURE, false) : undefined,
  /** The database disk size (Render doesn't expose it): admins see how full it is, and near it
   *  writes that add data stop (src/storage.ts). 1 GB unless set; 0 turns the guard off. */
  dbDiskBytes: Number(process.env.DB_DISK_GB?.trim() || 1) * 1024 ** 3,
  /** For timestamps the server writes into notes (captured items). */
  timeZone: process.env.TIME_ZONE?.trim() || "Europe/London",
  /** Encrypts people's AI API keys at rest (F13). Any long random string; changing it means
   *  everyone re-enters their key. Unset = assistants can't be added. */
  secretsKey: process.env.SECRETS_KEY?.trim() ?? "",
  /** GitHub's REST API (F14); tests point it at a fake. */
  githubApi: (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, ""),
  maxImportBytes: Number(process.env.MAX_IMPORT_MB ?? 200) * 1024 * 1024,
};
