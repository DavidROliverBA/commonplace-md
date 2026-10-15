// Encryption for secrets kept in the database (people's AI API keys, F13): AES-256-GCM with a key
// derived from SECRETS_KEY, which lives only in the server's environment. A database dump or
// backup alone can't reveal the keys.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HttpError } from "./auth";
import { settings } from "./settings";

const key = () => {
  if (!settings.secretsKey) throw new HttpError(503, "This server can't store AI keys or GitHub tokens yet: an admin needs to set SECRETS_KEY (see README).");
  return createHash("sha256").update(`commonplace:secrets:${settings.secretsKey}`).digest();
};

export const secretsAvailable = () => !!settings.secretsKey;

/** "v1.<iv>.<tag>.<ciphertext>", base64url. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Reverse of seal(); a 409 asking for the key again when SECRETS_KEY has changed since. */
export function open(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new HttpError(500, "A stored key is damaged; enter it again in Settings → AI assistants.");
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    // SECRETS_KEY changed since the key was saved.
    throw new HttpError(409, "This assistant's key can't be read any more (the server's SECRETS_KEY changed). Enter the key again in Settings → AI assistants.");
  }
}
