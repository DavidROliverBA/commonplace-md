// JSON API: every /api route, plus /mcp. Every handler runs through `route()`, which enforces
// same-origin on mutations and turns HttpError (and validation errors) into a JSON error with the
// right status. `id()` parses the numeric ids in the URL. Vault routes start with
// `vaultCtx(ctx, role)`: any write needs at least "editor", and a non-member gets 404, never 403.

import type { Server } from "bun";
import { z } from "zod";
import * as auth from "./auth";
import { HttpError, requireUser, type User } from "./auth";
import { ChatRequest, chatResponse } from "./ai";
import * as assistants from "./assistants";
import * as git from "./git";
import * as github from "./github";
import * as captureTokens from "./capture";
import { mcpRoute } from "./mcp";
import * as tokens from "./tokens";
import { flushNote, kick } from "./collab";
import { sql } from "./db";
import { providerName, semanticEnabled } from "./embed";
import { subscribe } from "./events";
import * as notes from "./notes";
import { related, search, suggest } from "./search";
import { secretsAvailable } from "./secrets";
import { withProperties } from "./props";
import { backlinksWithProperty, dayActivity, listTypes, renameType, saveViews, typeNotes, updateType } from "./typeIndex";
import { PROP_KINDS, TYPE_COLOURS } from "./types";
import { saveWeblink } from "./weblinks";
import { bookmarks, linkMention, removeSearch, savedSearches, saveSearch, setBookmark, setTask, unlinkedMentions, vaultTasks } from "./vaultViews";
import { dataviewFile, dataviewPages, runDataview } from "./dataviewVault";
import { settings } from "./settings";
import { assertRoom, FULL_AT, storageState, WARN_AT } from "./storage";
import { addTour } from "./tour";
import * as site from "./publish";
import { backupStream, type ConflictMode, exportZip, importFiles, saveAttachment } from "./transfer";
import * as vaults from "./vaults";

type Params = Record<string, string>;
type Ctx = { req: Request & { params: Params }; server: Server<any>; url: URL };
type Handler = (ctx: Ctx) => Promise<Response | unknown>;

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);

function route(fn: Handler) {
  return async (req: Request & { params: Params }, server: Server<any>) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !auth.sameOrigin(req)) throw new HttpError(403, "Cross-origin request refused");
      const out = await fn({ req, server, url: new URL(req.url) });
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
      if (err instanceof z.ZodError) return json({ error: err.issues.map((i) => i.message).join("; ") }, { status: 400 });
      if (err instanceof Error && /^Invalid path|^Path is/.test(err.message)) return json({ error: err.message }, { status: 400 });
      // A unique-constraint race (two creates at once) is a conflict, not a server fault.
      if ((err as { code?: string })?.code === "23505") return json({ error: "That already exists" }, { status: 409 });
      console.error(`${req.method} ${new URL(req.url).pathname} failed:`, err);
      return json({ error: "Something went wrong on the server" }, { status: 500 });
    }
  };
}

const id = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, "Not found");
  return n;
};

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(data);
}

/** Resolve :v and check the caller's role in that vault. */
async function vaultCtx(ctx: Ctx, min: vaults.Role) {
  const user = await requireUser(ctx.req);
  const vaultId = id(ctx.req.params.v);
  const role = await vaults.requireRole(vaultId, user, min);
  return { user, vaultId, role };
}

async function requireAdmin(req: Request): Promise<User> {
  const user = await requireUser(req);
  if (!user.is_admin) throw new HttpError(403, "Admins only");
  return user;
}

const Credentials = z.object({ email: z.string().max(320), password: z.string().max(1024) });
const Role = z.enum(["owner", "editor", "viewer"]);
const AssistantDraft = z.object({
  name: z.string().max(30),
  provider: z.enum(["anthropic", "openai", "relaxai", "compatible"]),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(1000),
  price: z.object({ in: z.number(), out: z.number() }).nullable().optional(),
  dailyCap: z.number().nullable().optional(),
});

export const apiRoutes = {
  // ── session ──────────────────────────────────────────────────────────────────────────
  "/api/session": {
    GET: route(async ({ req }) => {
      const user = await auth.currentUser(req);
      const [{ n }] = (await sql`select count(*)::int as n from users`) as any;
      const [inst] = await sql`select value from server_info where key = 'instance'`;
      return {
        instance: inst?.value ?? "",
        user,
        needsSetup: n === 0,
        setupTokenRequired: n === 0 && !!settings.setupToken,
        allowSignup: settings.allowSignup || n === 0,
        search: { semantic: semanticEnabled(), provider: providerName() },
        ai: { available: secretsAvailable() },
        // Admins are told when the database is getting full (N9, src/storage.ts).
        storage: user?.is_admin ? await storageState() : undefined,
      };
    }),
  },
  "/api/register": {
    POST: route(async ({ req }) => {
      const b = await body(req, Credentials.extend({ name: z.string().max(200).default(""), setupToken: z.string().max(512).optional() }));
      const user = await auth.register(b);
      const cookie = await auth.startSession(req, user.id);
      // A new account starts with a vault of its own so the first screen isn't empty.
      await vaults.createVault(user, `${user.name}'s vault`);
      return json({ user }, { headers: { "Set-Cookie": cookie } });
    }),
  },
  "/api/login": {
    POST: route(async ({ req }) => {
      const b = await body(req, Credentials);
      const user = await auth.login(b.email, b.password, auth.clientAddress(req));
      return json({ user }, { headers: { "Set-Cookie": await auth.startSession(req, user.id) } });
    }),
  },
  "/api/logout": {
    POST: route(async ({ req }) => {
      kick({ sessionHash: auth.sessionHash(req) }, "signed out");
      return json({ ok: true }, { headers: { "Set-Cookie": await auth.endSession(req) } });
    }),
  },
  "/api/me": {
    PATCH: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ name: z.string().max(200).optional(), currentPassword: z.string().optional(), newPassword: z.string().optional() }));
      if (b.name?.trim()) await sql`update users set name = ${b.name.trim()} where id = ${user.id}`;
      if (b.newPassword) {
        await auth.login(user.email, b.currentPassword ?? "", auth.clientAddress(req));
        auth.validatePassword(b.newPassword);
        await sql`update users set password_hash = ${await Bun.password.hash(b.newPassword)} where id = ${user.id}`;
        // A new password signs out every other device, in case someone else knew the old one.
        const others = await sql`delete from sessions where user_id = ${user.id} and token_hash <> ${auth.sessionHash(req)} returning token_hash`;
        for (const s of others) kick({ sessionHash: s.token_hash }, "password changed");
      }
      return { user: await auth.currentUser(req) };
    }),
  },

  // Tokens for clients other than the browser (src/tokens.ts): the iPhone Shortcut, MCP agents.
  "/api/me/tokens": {
    GET: route(async ({ req }) => tokens.listTokens((await requireUser(req)).id)),
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(
        req,
        z.object({
          kind: z.enum(["capture", "mcp"]).default("capture"),
          vaultId: z.number().int().positive().optional(),
          name: z.string().max(100).default(""),
          notePath: z.string().max(500).default("Inbox"),
          readOnly: z.boolean().default(false),
        }),
      );
      return tokens.createToken(user, b);
    }),
  },
  "/api/me/tokens/:id": {
    DELETE: route(async ({ req }) => {
      const user = await requireUser(req);
      await tokens.revokeToken(user.id, id(req.params.id));
    }),
  },
  // Bring your own AI (src/assistants.ts, src/ai.ts). Keys are write-only from here on.
  "/api/me/assistants": {
    GET: route(async ({ req }) => assistants.listAssistants((await requireUser(req)).id)),
    POST: route(async ({ req }) => assistants.createAssistant(await requireUser(req), await body(req, AssistantDraft))),
  },
  "/api/me/assistants/test": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ id: z.number().int().positive().optional(), draft: AssistantDraft.optional() }));
      return assistants.testAssistant(user, b);
    }),
  },
  "/api/me/assistants/:id": {
    PATCH: route(async ({ req }) => assistants.updateAssistant(await requireUser(req), id(req.params.id), await body(req, AssistantDraft.partial()))),
    DELETE: route(async ({ req }) => {
      const user = await requireUser(req);
      await assistants.deleteAssistant(user.id, id(req.params.id));
    }),
  },
  "/api/ai/chat": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      return chatResponse(user, await body(req, ChatRequest), req.signal);
    }),
  },
  // Model Context Protocol for Claude and other agents (src/mcp.ts). Bearer MCP token.
  "/mcp": { POST: mcpRoute, GET: mcpRoute, DELETE: mcpRoute },
  // Share from the iPhone: a bearer capture token, never a cookie or a URL token.
  "/api/capture": {
    POST: route(async ({ req }) => {
      try {
        return await captureTokens.capture(req);
      } catch (e) {
        // The Shortcut shows `message` in its notification, so failures say why there too.
        if (e instanceof HttpError) return json({ ok: false, error: e.message, message: e.message }, { status: e.status });
        throw e;
      }
    }),
  },

  // ── admin ────────────────────────────────────────────────────────────────────────────
  "/api/admin/users": {
    GET: route(async ({ req }) => {
      await requireAdmin(req);
      return sql`select id, email, name, is_admin, created_at from users order by created_at`;
    }),
    POST: route(async ({ req }) => {
      await requireAdmin(req);
      const b = await body(req, Credentials.extend({ name: z.string().max(200).default(""), is_admin: z.boolean().default(false) }));
      const user = await auth.createUser({ ...b, isAdmin: b.is_admin });
      await vaults.createVault(user, `${user.name}'s vault`);
      return user;
    }),
  },
  // Off-site backups (.github/workflows/backup.yml). A bearer token, never a cookie or URL token.
  "/api/backup": {
    GET: route(async ({ req }) => {
      const given = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
      if (!settings.backupToken) throw new HttpError(404, "Not found");
      if (!auth.tokenMatches(given, settings.backupToken)) throw new HttpError(401, "Bad backup token");
      const zip = backupStream();
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(zip, {
        headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="commonplace-backup-${stamp}.zip"`, "Cache-Control": "no-store" },
      });
    }),
  },
  "/api/admin/storage": {
    GET: route(async ({ req }) => {
      await requireAdmin(req);
      const [r] = await sql`
        select pg_database_size(current_database())::bigint as database,
               (select coalesce(sum(size), 0) from attachments)::bigint as attachments,
               (select coalesce(sum(octet_length(content) + coalesce(octet_length(ydoc), 0)), 0) from notes)::bigint as notes,
               (select coalesce(sum(octet_length(content)), 0) from note_revisions)::bigint as revisions,
               (select coalesce(sum(octet_length(content) + coalesce(octet_length(ydoc), 0) + octet_length(revisions::text)), 0) from trashed_notes)::bigint as trash`;
      return { ...r, limit: settings.dbDiskBytes || null, warnAt: WARN_AT, fullAt: FULL_AT };
    }),
  },
  "/api/admin/users/:id": {
    DELETE: route(async ({ req }) => {
      const admin = await requireAdmin(req);
      const uid = id(req.params.id);
      if (uid === admin.id) throw new HttpError(400, "You can't delete your own account");
      // Vaults where they're the only owner pass to the admin rather than becoming ownerless.
      await sql`
        insert into vault_members (vault_id, user_id, role)
        select m.vault_id, ${admin.id}, 'owner' from vault_members m
        where m.user_id = ${uid} and m.role = 'owner'
          and not exists (select 1 from vault_members o where o.vault_id = m.vault_id and o.role = 'owner' and o.user_id <> ${uid})
        on conflict (vault_id, user_id) do update set role = 'owner'`;
      await sql`delete from users where id = ${uid}`;
      kick({ userId: uid }, "account removed");
    }),
  },

  // GitHub (F14, src/github.ts): each person's own token, write-only like AI keys.
  "/api/me/github": {
    GET: route(async ({ req }) => ({ available: secretsAvailable(), connection: await github.connection((await requireUser(req)).id) })),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      return github.connect(user.id, (await body(req, z.object({ token: z.string().max(300) }))).token);
    }),
    DELETE: route(async ({ req }) => github.disconnect((await requireUser(req)).id)),
  },
  "/api/me/github/repos": {
    GET: route(async ({ req }) => github.listRepos(await github.clientFor((await requireUser(req)).id))),
  },
  "/api/me/github/repos/:owner/:repo/branches": {
    GET: route(async ({ req }) => github.listBranches(await github.clientFor((await requireUser(req)).id), `${req.params.owner}/${req.params.repo}`)),
  },
  "/api/me/github/repos/:owner/:repo/folders": {
    GET: route(async ({ req, url }) => git.folders(await github.clientFor((await requireUser(req)).id), `${req.params.owner}/${req.params.repo}`, url.searchParams.get("branch") ?? "main")),
  },
  "/api/vaults/github": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ repo: z.string().max(200), branch: z.string().min(1).max(200), folder: z.string().max(500).optional(), name: z.string().max(200).optional() }));
      return git.copyIn(user, b);
    }),
  },

  // ── vaults ───────────────────────────────────────────────────────────────────────────
  "/api/vaults": {
    GET: route(async ({ req }) => vaults.listVaults((await requireUser(req)).id)),
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ name: z.string().min(1).max(200) }));
      return vaults.createVault(user, b.name);
    }),
  },
  "/api/vaults/:v": {
    PATCH: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      await vaults.renameVault(vaultId, (await body(ctx.req, z.object({ name: z.string().max(200) }))).name);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      kick({ vaultId }, "vault deleted");
      await vaults.deleteVault(vaultId);
    }),
  },
  "/api/vaults/:v/members": {
    GET: route(async (ctx) => vaults.listMembers((await vaultCtx(ctx, "viewer")).vaultId)),
    // A member's email changes their role; anyone else's gets an invitation (N13). The reply for an
    // invitation is the same whether or not the email has an account.
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const b = await body(ctx.req, z.object({ email: z.string().max(320), role: Role }));
      const r = await vaults.setMember(vaultId, b.email, b.role, user);
      if (r.status === "invited") return { status: "invited" };
      // Reconnect them so a demotion to viewer takes effect in open editors.
      kick({ vaultId, userId: r.userId }, "role changed");
      return { status: "updated" };
    }),
  },
  "/api/vaults/:v/invites": {
    GET: route(async (ctx) => vaults.listInvites((await vaultCtx(ctx, "owner")).vaultId)),
  },
  "/api/vaults/:v/invites/:id": {
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      await vaults.cancelInvite(vaultId, id(ctx.req.params.id));
    }),
  },
  // The signed-in person's own invitations: accept to join, decline to drop it.
  "/api/invitations": {
    GET: route(async ({ req }) => vaults.myInvites(await requireUser(req))),
  },
  "/api/invitations/:id/accept": {
    POST: route(async ({ req }) => vaults.acceptInvite(await requireUser(req), id(req.params.id))),
  },
  "/api/invitations/:id": {
    DELETE: route(async ({ req }) => vaults.declineInvite(await requireUser(req), id(req.params.id))),
  },
  "/api/vaults/:v/members/:uid": {
    DELETE: route(async (ctx) => {
      const user = await requireUser(ctx.req);
      const vaultId = id(ctx.req.params.v);
      const uid = id(ctx.req.params.uid);
      // Owners remove anyone; anyone may leave.
      await vaults.requireRole(vaultId, user, uid === user.id ? "viewer" : "owner");
      await vaults.removeMember(vaultId, uid, user);
      kick({ vaultId, userId: uid }, "removed from vault");
    }),
  },
  // Undo of Remove, for the owner who just did it (a few minutes); otherwise invite them again.
  "/api/vaults/:v/members/:uid/restore": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      await vaults.restoreMember(vaultId, id(ctx.req.params.uid), user);
    }),
  },
  "/api/vaults/:v/events": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (s: string) => {
            try {
              controller.enqueue(enc.encode(s));
            } catch {
              cleanup();
            }
          };
          send(": connected\n\n");
          const off = subscribe(vaultId, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
          // Each ping re-checks the session and membership, so signing out, removal from the
          // vault or account deletion ends the stream within 20 s.
          const ping = setInterval(async () => {
            try {
              const u = await auth.currentUser(ctx.req);
              if (!u) throw new Error("signed out");
              await vaults.roleIn(vaultId, u.id);
              send(": ping\n\n");
            } catch {
              cleanup();
              try {
                controller.close();
              } catch {}
            }
          }, 20_000);
          cleanup = () => {
            off();
            clearInterval(ping);
          };
          ctx.req.signal.addEventListener("abort", () => cleanup());
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" },
      });
    }),
  },

  // ── notes ────────────────────────────────────────────────────────────────────────────
  "/api/vaults/:v/notes": {
    GET: route(async (ctx) => notes.listNotes((await vaultCtx(ctx, "viewer")).vaultId)),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1), content: z.string().max(5_000_000).default("") }));
      return notes.createNote(vaultId, user.id, b.path, b.content);
    }),
  },
  "/api/vaults/:v/notes/:id": {
    GET: route(async (ctx) => {
      const { vaultId, role } = await vaultCtx(ctx, "viewer");
      return { ...(await notes.getNote(vaultId, id(ctx.req.params.id))), role };
    }),
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1), updateLinks: z.boolean().default(true) }));
      return notes.renameNote(vaultId, id(ctx.req.params.id), b.path, user.id, b.updateLinks);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      // Close the live room first and save it, so Trash holds the latest text.
      kick({ noteId }, "note deleted");
      await flushNote(noteId);
      return { trashId: await notes.deleteNote(vaultId, noteId, user.id) };
    }),
  },
  "/api/vaults/:v/notes/:id/content": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const b = await body(ctx.req, z.object({ content: z.string().max(5_000_000) }));
      await notes.overwriteContent(noteId, b.content, user.id);
      return notes.getNote(vaultId, noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/links": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      const [me, backlinks, outgoing, rel] = await Promise.all([
        notes.getNote(vaultId, noteId),
        backlinksWithProperty(vaultId, noteId),
        notes.outgoing(vaultId, noteId),
        related(vaultId, noteId).catch(() => []),
      ]);
      return { backlinks, outgoing, related: rel, created_at: me.created_at };
    }),
  },
  // Set properties without touching the rest of the note, merged into live typing (type pages).
  "/api/vaults/:v/notes/:id/properties": {
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const PropValue = z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(10_000)).max(500), z.null()]);
      const b = await body(ctx.req, z.object({ set: z.record(z.string().min(1).max(200), PropValue) }));
      await notes.overwriteContent(noteId, (cur) => withProperties(cur, b.set), user.id);
      return notes.getNote(vaultId, noteId);
    }),
  },
  // Types (F16): the vault's types, one type's notes and saved views, and a day's activity.
  "/api/vaults/:v/types": {
    GET: route(async (ctx) => listTypes((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/types/:name": {
    GET: route(async (ctx) => typeNotes((await vaultCtx(ctx, "viewer")).vaultId, decodeURIComponent(ctx.req.params.name ?? ""))),
    // The type editor saves the whole definition at once.
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const Prop = z.object({
        name: z.string().max(100),
        kind: z.enum(PROP_KINDS as [string, ...string[]]),
        options: z.array(z.string().max(200)).max(100).optional(),
        type: z.string().max(200).optional(),
        many: z.boolean().optional(),
      });
      const b = await body(ctx.req, z.object({ icon: z.string().max(40), colour: z.enum(TYPE_COLOURS), properties: z.array(Prop).max(100), cards: z.boolean().optional() }));
      await updateType(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b as any);
    }),
  },
  "/api/vaults/:v/types/:name/rename": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ to: z.string().min(1).max(200) }));
      return { changed: await renameType(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b.to) };
    }),
  },
  "/api/vaults/:v/types/:name/views": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ yaml: z.string() }));
      await saveViews(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b.yaml);
    }),
  },
  // Weblinks (src/weblinks.ts), then small views (src/vaultViews.ts): tasks across the vault,
  // unlinked mentions, bookmarks and saved searches.
  "/api/vaults/:v/weblinks": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ url: z.string().min(1).max(4000), title: z.string().max(300).default("") }));
      return saveWeblink(vaultId, user.id, b.url, b.title);
    }),
  },
  // Dataview queries in a note (src/dataview.ts), run over the vault as its reader sees it.
  "/api/vaults/:v/dataview": {
    POST: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const b = await body(
        ctx.req,
        z.object({
          noteId: z.number().int().nullable(),
          offset: z.number().int().min(-14 * 60).max(14 * 60),
          tz: z.string().max(64).optional(),
          items: z.array(z.object({ kind: z.enum(["query", "inline"]), source: z.string().max(20_000) })).max(200),
        }),
      );
      return runDataview(vaultId, b.noteId, b.offset, b.items, b.tz);
    }),
  },
  // dataviewjs (web/sandbox/dvjs.ts) runs in the reader's browser, on the pages they can read.
  "/api/vaults/:v/dataview/pages": {
    GET: route(async (ctx) => dataviewPages((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/dataview/file": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const path = new URL(ctx.req.url).searchParams.get("path") ?? "";
      if (!path || path.length > 1024) throw new HttpError(400, "Which file?");
      return { text: await dataviewFile(vaultId, path) };
    }),
  },
  "/api/vaults/:v/tasks": {
    GET: route(async (ctx) => vaultTasks((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/notes/:id/tasks": {
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ line: z.number().int().min(0), text: z.string().max(10_000), done: z.boolean() }));
      await setTask(vaultId, id(ctx.req.params.id), user.id, b.line, b.text, b.done);
    }),
  },
  "/api/vaults/:v/notes/:id/mentions": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return unlinkedMentions(vaultId, id(ctx.req.params.id));
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ source: z.number().int().positive() }));
      await linkMention(vaultId, id(ctx.req.params.id), b.source, user.id);
    }),
  },
  "/api/vaults/:v/bookmarks": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return bookmarks(user.id, vaultId);
    }),
  },
  "/api/vaults/:v/bookmarks/:id": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return setBookmark(user.id, vaultId, id(ctx.req.params.id), true);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return setBookmark(user.id, vaultId, id(ctx.req.params.id), false);
    }),
  },
  // ── website (F18): what's published, Publish, take down ─────────────────────────────────
  "/api/vaults/:v/site": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return site.siteState(vaultId);
    }),
  },
  "/api/vaults/:v/site/settings": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const { include } = await body(ctx.req, z.object({ include: z.array(z.string().max(512)).max(1000) }));
      return site.saveSettings(vaultId, user.id, include);
    }),
  },
  "/api/vaults/:v/site/publish": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      // The owner's time zone, for Dataview's dates (results are frozen at Publish).
      // What each dataviewjs block drew, run in the owner's browser (cleaned in publish.ts).
      const b = await body(
        ctx.req,
        z.object({
          offset: z.number().int().min(-14 * 60).max(14 * 60).default(0),
          tz: z.string().max(64).optional(),
          frozen: z.array(z.object({ path: z.string().max(1024), code: z.string().max(200_000), html: z.string().max(2_000_000) })).max(5000).default([]),
        }),
      );
      return site.publish(vaultId, user, b.offset, b.tz, b.frozen);
    }),
  },
  // dataviewjs at Publish: the blocks to run and the published notes they see, and the files
  // they may read (published ones only).
  "/api/vaults/:v/site/dataviewjs": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return site.dataviewjsToFreeze(vaultId);
    }),
  },
  "/api/vaults/:v/site/dataviewjs/file": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      const path = new URL(ctx.req.url).searchParams.get("path") ?? "";
      if (!path || path.length > 1024) throw new HttpError(400, "Which file?");
      return { text: await site.dataviewjsFreezeFile(vaultId, path) };
    }),
  },
  "/api/vaults/:v/site/live": {
    PUT: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      const { live } = await body(ctx.req, z.object({ live: z.boolean() }));
      await site.setLive(vaultId, live);
    }),
  },
  "/api/vaults/:v/tour": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return addTour(vaultId, user);
    }),
  },
  "/api/vaults/:v/searches": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return savedSearches(user.id, vaultId);
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return saveSearch(user.id, vaultId, (await body(ctx.req, z.object({ query: z.string().max(500) }))).query);
    }),
  },
  "/api/vaults/:v/searches/:id": {
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return removeSearch(user.id, vaultId, id(ctx.req.params.id));
    }),
  },
  "/api/vaults/:v/days/:day": {
    GET: route(async (ctx) => dayActivity((await vaultCtx(ctx, "viewer")).vaultId, ctx.req.params.day ?? "")),
  },
  "/api/vaults/:v/notes/:id/revisions": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      return notes.revisions(noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/revisions/:rid": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      return notes.revision(noteId, id(ctx.req.params.rid));
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const r = await notes.revision(noteId, id(ctx.req.params.rid));
      await notes.overwriteContent(noteId, r.content, user.id, "restore");
      return notes.getNote(vaultId, noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/export": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const n = await notes.getNote(vaultId, id(ctx.req.params.id));
      return new Response(n.content, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(n.title)}.md`,
        },
      });
    }),
  },
  "/api/vaults/:v/trash": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "editor");
      return { days: notes.TRASH_DAYS, items: await notes.listTrash(vaultId) };
    }),
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return { deleted: await notes.purgeFromTrash(vaultId) };
    }),
  },
  "/api/vaults/:v/trash/:id": {
    // Gone for good, like emptying Trash: the owner's call. Editors can still restore (N13).
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return { deleted: await notes.purgeFromTrash(vaultId, id(ctx.req.params.id)) };
    }),
  },
  "/api/vaults/:v/trash/:id/restore": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return notes.restoreNote(vaultId, id(ctx.req.params.id), user.id);
    }),
  },
  "/api/vaults/:v/folders": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return notes.listFolders(vaultId);
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1).max(512) }));
      return { path: await notes.createFolder(vaultId, b.path, user.id) };
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      await notes.deleteFolder(vaultId, ctx.url.searchParams.get("path") ?? "", user.id);
    }),
  },
  "/api/vaults/:v/folders/rename": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ from: z.string().min(1), to: z.string().min(1) }));
      return { moved: await notes.renameFolder(vaultId, b.from, b.to, user.id) };
    }),
  },
  "/api/vaults/:v/resolve": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const hit = await notes.resolveLink(vaultId, ctx.url.searchParams.get("target") ?? "");
      if (!hit) throw new HttpError(404, "No such note");
      return hit;
    }),
  },
  "/api/vaults/:v/search": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return search(vaultId, (ctx.url.searchParams.get("q") ?? "").slice(0, 500));
    }),
  },
  "/api/vaults/:v/suggest": {
    GET: route(async (ctx) => suggest((await vaultCtx(ctx, "viewer")).vaultId, (ctx.url.searchParams.get("q") ?? "").slice(0, 200))),
  },
  "/api/vaults/:v/tags": {
    GET: route(async (ctx) => notes.tagCounts((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/graph": {
    GET: route(async (ctx) => notes.graph((await vaultCtx(ctx, "viewer")).vaultId)),
  },

  // ── GitHub vaults (F14, src/git.ts): the branch, its changes, the pull request ─────────
  "/api/vaults/:v/git": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return git.status(vaultId, user.id);
    }),
  },
  "/api/vaults/:v/git/diff": {
    GET: route(async (ctx) => git.diff((await vaultCtx(ctx, "viewer")).vaultId, ctx.url.searchParams.get("path") ?? "")),
  },
  "/api/vaults/:v/git/revert": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.revert(vaultId, user, (await body(ctx.req, z.object({ path: z.string().max(1000) }))).path);
    }),
  },
  "/api/vaults/:v/git/push": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ message: z.string().max(10_000), title: z.string().max(300).optional(), body: z.string().max(60_000).optional(), branch: z.string().max(200).optional() }));
      return git.push(vaultId, user, b);
    }),
  },
  "/api/vaults/:v/git/cancel": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.cancel(vaultId, user);
    }),
  },
  "/api/vaults/:v/git/update": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.update(vaultId, user);
    }),
  },
  "/api/vaults/:v/git/resolve": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().max(1000), take: z.enum(["mine", "theirs"]) }));
      return git.resolve(vaultId, user, b.path, b.take);
    }),
  },
  "/api/vaults/:v/git/branch": {
    PUT: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "editor");
      await git.renameBranch(vaultId, (await body(ctx.req, z.object({ name: z.string().max(200) }))).name);
    }),
  },

  // ── import / export / files ──────────────────────────────────────────────────────────
  "/api/vaults/:v/import": {
    POST: route(async (ctx) => {
      const { vaultId, user, role } = await vaultCtx(ctx, "editor");
      const len = Number(ctx.req.headers.get("content-length") ?? 0);
      if (len > settings.maxImportBytes) throw new HttpError(413, `Import is larger than ${settings.maxImportBytes / 1048576} MB`);
      await assertRoom(len);
      const form = await ctx.req.formData();
      const mode = (form.get("mode") as ConflictMode) ?? "overwrite";
      if (!["overwrite", "skip", "keep-both"].includes(mode)) throw new HttpError(400, "Unknown conflict mode");
      const paths = form.getAll("paths").map(String);
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (!files.length) throw new HttpError(400, "Choose some .md files, a folder or a .zip to import");
      const items = await Promise.all(
        // A folder upload sends each file's relative path alongside it ("paths"), since
        // File.name is only the basename.
        files.map(async (f, i) => ({ path: paths[i] || f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      return importFiles(vaultId, user.id, items, mode, String(form.get("folder") ?? ""), role === "owner");
    }),
  },
  "/api/vaults/:v/export": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const [v] = await sql`select name from vaults where id = ${vaultId}`;
      const folder = ctx.url.searchParams.get("folder") || undefined;
      const zip = await exportZip(vaultId, folder);
      const name = `${v!.name}${folder ? ` - ${folder.split("/").pop()}` : ""}`.replace(/[\\/:*?"<>|]/g, "-");
      return new Response(zip as Uint8Array<ArrayBuffer>, {
        headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip` },
      });
    }),
  },
  "/api/vaults/:v/files": {
    // ?path=exact/path.png, or ?name=path.png resolved by basename.
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const p = ctx.url.searchParams.get("path") ?? "";
      const [f] = await sql`
        select path, mime, data from attachments
        where vault_id = ${vaultId} and (lower(path) = lower(${p}) or lower(path) like ${"%/" + p.toLowerCase().replace(/[%_\\]/g, "\\$&")})
        order by (lower(path) = lower(${p})) desc, length(path) limit 1`;
      if (!f) throw new HttpError(404, "File not found");
      return new Response(new Uint8Array(f.data), {
        headers: {
          "Content-Type": f.mime,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
          // An uploaded SVG must never run script in our origin.
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        },
      });
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const form = await ctx.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "No file");
      const path = await saveAttachment(vaultId, user.id, file, String(form.get("folder") ?? "attachments"));
      return { path };
    }),
  },
};
