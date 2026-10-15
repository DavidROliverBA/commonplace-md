// HTTP + WebSocket server. Bun bundles the React client from web/index.html on the fly (with
// hot reload under `bun run dev`), so there is no separate build step.

import index from "../web/index.html";
import { apiRoutes } from "./api";
import { currentUser, sameOrigin, sessionHash } from "./auth";
import { type CollabData, flushAll, onClose, onMessage, onOpen } from "./collab";
import { sql } from "./db";
import { backfill } from "./embed";
import { dbVersions, migrate } from "./migrate";
import { pruneRevisions, purgeTrash } from "./notes";
import { serveSite } from "./publish";
import { canWrite, roleIn } from "./vaults";
import { generatedSetupToken, settings } from "./settings";

await migrate();

// Trash keeps notes for TRASH_DAYS, and each note its newest versions; tidy at boot and every
// six hours.
const purge = () =>
  Promise.all([
    purgeTrash().then((n) => n && console.log(`purged ${n} notes from Trash`)),
    pruneRevisions().then((n) => n && console.log(`pruned ${n} old note versions`)),
  ]).catch((e) => console.error("tidying failed:", e));
void purge();
setInterval(purge, 6 * 60 * 60 * 1000).unref();

const server = Bun.serve<CollabData>({
  port: settings.port,
  hostname: "0.0.0.0", // reachable from a phone on the same network
  idleTimeout: 60, // SSE pings every 20s keep event streams open
  // The largest request is an import; anything bigger is refused before it's read, whether or not
  // it says its length up front.
  maxRequestBodySize: settings.maxImportBytes + 1024 * 1024,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/manifest.webmanifest": () =>
      new Response(Bun.file(new URL("../web/manifest.webmanifest", import.meta.url)), { headers: { "Content-Type": "application/manifest+json" } }),
    "/icon.svg": new Response(Bun.file(new URL("../web/icon.svg", import.meta.url)), { headers: { "Content-Type": "image/svg+xml" } }),
    "/apple-touch-icon.png": new Response(Bun.file(new URL("../web/apple-touch-icon.png", import.meta.url)), { headers: { "Content-Type": "image/png" } }),
    // The service worker (F4), at the root so it can serve every page; never cached itself, so a
    // new version reaches people on their next visit.
    "/sw.js": new Response(Bun.file(new URL("../web/sw.js", import.meta.url)), {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" },
    }),
    "/health": async () => {
      await sql`select 1`;
      return Response.json({ ok: true });
    },
    ...apiRoutes,
    "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),

    // Published sites (F18): served from their snapshot, with no app around them.
    "/p/*": (req: Request) => serveSite(req),

    // Live editing socket. The y-websocket client connects to `/ws/<noteId>`.
    "/ws/:noteId": async (req: Bun.BunRequest<"/ws/:noteId">, srv: Bun.Server<CollabData>) => {
      if (!sameOrigin(req)) return new Response("Cross-origin socket refused", { status: 403 });
      const user = await currentUser(req);
      if (!user) return new Response("Sign in required", { status: 401 });
      const noteId = Number(req.params.noteId);
      const [n] = Number.isSafeInteger(noteId) ? await sql`select vault_id from notes where id = ${noteId}` : [];
      if (!n) return new Response("Note not found", { status: 404 });
      let role;
      try {
        role = await roleIn(n.vault_id, user.id);
      } catch {
        return new Response("Note not found", { status: 404 });
      }
      const data: CollabData = { kind: "collab", noteId, vaultId: n.vault_id, userId: user.id, canWrite: canWrite(role), sessionHash: sessionHash(req) };
      if (srv.upgrade(req, { data })) return undefined as unknown as Response;
      return new Response("Expected a WebSocket", { status: 426 });
    },

    // Everything else is the single-page app (client-side routing).
    "/*": index,
  },
  websocket: {
    open: (ws) => void onOpen(ws),
    message: (ws, msg) => onMessage(ws, msg as Buffer),
    close: (ws) => onClose(ws),
    idleTimeout: 120,
    maxPayloadLength: 16 * 1024 * 1024,
  },
});

if (generatedSetupToken) {
  const [{ count }] = (await sql`select count(*)::int as count from users`) as unknown as [{ count: number }];
  if (count === 0) console.log(`No accounts yet: create the first (admin) account with the setup token ${generatedSetupToken}, or set SETUP_TOKEN.`);
}

const queued = await backfill();
console.log(
  `commonplace on http://localhost:${server.port}  (${await dbVersions()}; embeddings: ${settings.embeddingProvider}${queued ? `, ${queued} notes queued` : ""})`,
);

async function shutdown() {
  console.log("flushing open notes…");
  // Render stops a slow process after 30 s; never hang here waiting on one stuck save.
  const flushed = await Promise.race([flushAll().then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!flushed) {
    const busy = await Promise.race([
      sql`select pid, state, wait_event_type, wait_event, left(query, 120) as query, now() - xact_start as age from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`.catch(() => []),
      Bun.sleep(2_000).then(() => "database not answering"),
    ]);
    console.error("shutdown: some notes didn't finish saving within 10 s; database activity:", busy);
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
