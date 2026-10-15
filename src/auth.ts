// Accounts and sessions. Passwords are argon2id via Bun.password. Sessions are random tokens in
// an HttpOnly cookie, stored server-side as SHA-256 hashes so signing out — or an admin deleting
// a user — revokes access immediately; api.ts closes that session's live sockets and event streams.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "./db";
import { settings } from "./settings";

export const SESSION_COOKIE = "cp_session";
const SESSION_DAYS = 60;

export interface User {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function isSecure(req: Request): boolean {
  if (settings.cookieSecure !== undefined) return settings.cookieSecure;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

function cookie(req: Request, value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}

export function validateEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, "Enter a valid email address");
  return e;
}

export function validatePassword(pw: string): void {
  if (pw.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
}

export async function createUser(input: { email: string; name: string; password: string; isAdmin?: boolean }): Promise<User> {
  const email = validateEmail(input.email);
  validatePassword(input.password);
  const name = input.name.trim() || email.split("@")[0]!;
  const hash = await Bun.password.hash(input.password);
  const [existing] = await sql`select 1 from users where email = ${email}`;
  if (existing) throw new HttpError(409, "An account with that email already exists");
  const [user] = await sql<User[]>`
    insert into users (email, name, password_hash, is_admin)
    values (${email}, ${name}, ${hash}, ${input.isAdmin ?? false})
    returning id, email, name, is_admin`;
  return user!;
}

/** Sign up: the first account is always allowed and becomes admin (given SETUP_TOKEN, if set);
 *  later ones need ALLOW_SIGNUP. */
export async function register(input: { email: string; name: string; password: string; setupToken?: string }): Promise<User> {
  return sql.begin(async (tx) => {
    // Serialise first-user creation so two simultaneous sign-ups can't both become admin.
    await tx`select pg_advisory_xact_lock(42001)`;
    const [{ count }] = (await tx`select count(*)::int as count from users`) as unknown as [{ count: number }];
    if (count > 0 && !settings.allowSignup) throw new HttpError(403, "Sign-up is invite-only. Ask an admin for an account.");
    // On a public deploy, whoever signs up first would become admin; the token closes that window.
    if (count === 0 && settings.setupToken && !tokenMatches(input.setupToken ?? "", settings.setupToken)) {
      throw new HttpError(403, "Wrong setup token. It's the SETUP_TOKEN set on the server.");
    }
    const email = validateEmail(input.email);
    validatePassword(input.password);
    const [existing] = await tx`select 1 from users where email = ${email}`;
    if (existing) throw new HttpError(409, "An account with that email already exists");
    const hash = await Bun.password.hash(input.password);
    const [user] = (await tx`
      insert into users (email, name, password_hash, is_admin)
      values (${email}, ${input.name.trim() || email.split("@")[0]!}, ${hash}, ${count === 0})
      returning id, email, name, is_admin`) as unknown as User[];
    return user!;
  });
}

/** Constant-time comparison of a presented secret with the expected one. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Failed sign-ins, per email and per client address: after FAIL_MAX within FAIL_WINDOW_MS, more
// attempts are refused until the window passes, so a password can't be guessed online and the
// argon2 checks can't be used to tie up the server. In memory, which is enough at one instance.
const FAIL_MAX = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, number[]>();

function recentFailures(key: string): number[] {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** The client's address as the proxy in front saw it: the last X-Forwarded-For entry, which the
 *  proxy appends (earlier entries are whatever the client sent). "direct" without a proxy. */
export const clientAddress = (req: Request) => req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "direct";

/** Check a password, refusing for a while after too many failures for this email or address. */
export async function login(email: string, password: string, from = "direct"): Promise<User> {
  const keys = [`e:${email.trim().toLowerCase()}`, `a:${from}`];
  if (keys.some((k) => recentFailures(k).length >= FAIL_MAX)) throw new HttpError(429, "Too many wrong passwords. Wait a few minutes and try again.");
  try {
    return await checkPassword(email, password);
  } catch (e) {
    for (const k of keys) failures.set(k, [...recentFailures(k), Date.now()]);
    if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    throw e;
  }
}

async function checkPassword(email: string, password: string): Promise<User> {
  const [row] = await sql`select id, email, name, is_admin, password_hash from users where email = ${email.trim().toLowerCase()}`;
  // Verify against a dummy hash when the user is unknown so timing doesn't reveal which emails exist.
  const ok = await Bun.password.verify(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, "Wrong email or password");
  return { id: row.id, email: row.email, name: row.name, is_admin: row.is_admin };
}
const DUMMY_HASH = await Bun.password.hash(randomBytes(16).toString("hex"));

/** Store a new session for the user; returns the Set-Cookie header value that carries it. */
export async function startSession(req: Request, userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  // Opportunistic cleanup; there's no cron.
  await sql`delete from sessions where expires_at < now()`;
  return cookie(req, token, SESSION_DAYS * 86400);
}

/** SHA-256 of the request's session token, or "" — identifies the session without storing it. */
export function sessionHash(req: Request): string {
  const token = cookieValue(req, SESSION_COOKIE);
  return token ? hashToken(token) : "";
}

/** Delete the request's session; returns a Set-Cookie header value that clears the cookie. */
export async function endSession(req: Request): Promise<string> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await sql`delete from sessions where token_hash = ${hashToken(token)}`;
  return cookie(req, "", 0);
}

export async function currentUser(req: Request): Promise<User | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const [user] = await sql<User[]>`
    select u.id, u.email, u.name, u.is_admin
    from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(token)} and s.expires_at > now()`;
  return user ?? null;
}

export async function requireUser(req: Request): Promise<User> {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

/**
 * CSRF defence for cookie-authenticated mutations and WebSocket upgrades: the browser's Origin
 * must match the Host it is talking to. SameSite=Lax covers most of this; the Origin check covers
 * the rest (and cross-site WebSocket hijacking, which SameSite does not).
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Browsers always send Origin on cross-origin requests and on every non-GET fetch, so a request
  // without one is a non-browser client (curl, a script) that has no ambient cookie to abuse.
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
