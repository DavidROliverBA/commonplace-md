// End-to-end: boots the real server against a scratch database and drives it as two users (Alice
// and Bob) — REST for accounts, vaults, notes, search, import/export, publishing, capture, MCP,
// AI assistants (test/fakeAi.ts) and GitHub vaults (test/fakeGitHub.ts); the stock y-websocket
// client for live collaboration. A second server with a tiny disk checks the storage guard.
//
// Needs the docker database (`docker compose up -d db`) and its `commonplace_test` database,
// which db/init/ creates on a fresh container (or TEST_DATABASE_URL). Every run drops and
// recreates that database's public schema. On a cluster created before db/init/, once:
//
//   docker compose exec db psql -U commonplace -c "create database commonplace_test"

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import postgres from "postgres";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startFakeAi } from "./fakeAi";
import { startFakeGitHub, TOKEN } from "./fakeGitHub";

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.TEST_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace_test";
let proc: ReturnType<typeof Bun.spawn>;
const testDb = postgres(DB, { onnotice: () => {} });

beforeAll(async () => {
  const sql = postgres(DB, { onnotice: () => {} });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await sql.end();
  proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), ALLOW_SIGNUP: "true", EMBEDDING_PROVIDER: "hash", EMBED_DEBOUNCE_MS: "50", SETUP_TOKEN: "test-setup-token", BACKUP_TOKEN: "test-backup-token", SECRETS_KEY: "test-secrets-key", ALLOW_LOCAL_AI: "true", WEBLINKS_ALLOW_LOCAL: "true", GITHUB_API_URL: "http://localhost:3187", NODE_ENV: "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("server did not start");
});

afterAll(async () => {
  proc?.kill();
  await testDb.end();
});

class Client {
  cookie = "";
  constructor(
    public name: string,
    public base = BASE,
  ) {}
  async req(path: string, opts: { method?: string; body?: unknown; form?: FormData; origin?: string } = {}) {
    const headers: Record<string, string> = { cookie: this.cookie, origin: opts.origin ?? this.base };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.base}/api${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data: data as any };
  }
  ok = async (path: string, opts: Parameters<Client["req"]>[1] = {}) => {
    const r = await this.req(path, opts);
    if (r.status >= 400) throw new Error(`${this.name} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  /** A live editing session using the stock y-websocket client, authenticated by our cookie. */
  live(noteId: number) {
    const { cookie, base } = this;
    const WS = class extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { cookie, origin: base } } as any);
      }
    };
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://${new URL(this.base).host}/ws`, String(noteId), doc, { WebSocketPolyfill: WS as any, disableBc: true });
    const synced = new Promise<void>((r) => provider.on("sync", (s: boolean) => s && r()));
    return { doc, text: doc.getText("content"), provider, synced };
  }
}

async function until(fn: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}

/**
 * Alice invites someone to a vault and they accept (N13): the way into a vault someone else owns.
 * When they're already a member, the same call just changes their role.
 */
async function addMember(vaultId: number, who: Client, role: "owner" | "editor" | "viewer") {
  const email = `${who.name}@example.com`;
  const r = await alice.ok(`/vaults/${vaultId}/members`, { method: "PUT", body: { email, role } });
  if (r.status === "updated") return;
  const invite = (await who.ok("/invitations")).find((i: any) => i.vault_id === vaultId);
  if (!invite) throw new Error(`${who.name} has no invitation to vault ${vaultId}`);
  await who.ok(`/invitations/${invite.id}/accept`, { method: "POST" });
}

/** Wait until the server's live room for a note holds `text`: a second live client sees it only
 *  once the server has it, so a test can rely on an edit having arrived (no fixed sleep). */
async function reachedServer(c: Client, noteId: number, text: string) {
  const w = c.live(noteId);
  await w.synced;
  await until(() => w.text.toString().includes(text));
  w.provider.destroy();
}

const alice = new Client("alice");
const bob = new Client("bob");
let vault: number;
const ids = { alpha: 0, beta: 0 };

describe("accounts and vaults", () => {
  test("the first account needs the setup token", async () => {
    const s = await new Client("x").ok("/session");
    expect(s.setupTokenRequired).toBe(true);
    const creds = { email: "mallory@example.com", password: "password-m" };
    expect((await new Client("x").req("/register", { body: creds })).status).toBe(403);
    expect((await new Client("x").req("/register", { body: { ...creds, setupToken: "guess" } })).status).toBe(403);
  });

  test("first account is admin and gets a vault", async () => {
    const r = await alice.ok("/register", { body: { email: "alice@example.com", password: "password-a", name: "Alice", setupToken: "test-setup-token" } });
    expect(r.user.is_admin).toBe(true);
    await bob.ok("/register", { body: { email: "bob@example.com", password: "password-b", name: "Bob" } });
    const s = await bob.ok("/session");
    expect(s.user.is_admin).toBe(false);
    expect(s.setupTokenRequired).toBe(false);
    const vs = await alice.ok("/vaults");
    expect(vs).toHaveLength(1);
    vault = vs[0].id;
  });

  test("wrong password and duplicate email are refused", async () => {
    expect((await new Client("x").req("/login", { body: { email: "alice@example.com", password: "nope" } })).status).toBe(401);
    expect((await new Client("x").req("/register", { body: { email: "ALICE@example.com", password: "password-z" } })).status).toBe(409);
  });

  test("after ten wrong passwords, sign-in is refused for a while, even with the right one", async () => {
    await new Client("dora").ok("/register", { body: { email: "dora@example.com", password: "password-d", name: "Dora" } });
    const login = (password: string, from = "203.0.113.9") =>
      fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": from }, body: JSON.stringify({ email: "dora@example.com", password }) });
    for (let i = 0; i < 10; i++) expect((await login("wrong-password")).status).toBe(401);
    const r = await login("password-d");
    expect(r.status).toBe(429);
    expect((await r.json()).error).toContain("Too many wrong passwords");
    // Counted per email too, so changing address doesn't help.
    expect((await login("password-d", "198.51.100.7")).status).toBe(429);
  });

  test("a new password signs out every other device", async () => {
    const other = new Client("alice on her phone");
    await other.ok("/login", { body: { email: "alice@example.com", password: "password-a" } });
    expect((await other.ok("/session")).user.email).toBe("alice@example.com");
    await alice.ok("/me", { method: "PATCH", body: { currentPassword: "password-a", newPassword: "password-a2" } });
    expect((await other.ok("/session")).user).toBeNull();
    expect((await alice.ok("/session")).user.email).toBe("alice@example.com");
    await alice.ok("/me", { method: "PATCH", body: { currentPassword: "password-a2", newPassword: "password-a" } });
  });

  test("cross-origin writes are refused", async () => {
    const r = await alice.req(`/vaults/${vault}/notes`, { body: { path: "Evil" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  test("other users can't see a vault until added", async () => {
    expect((await bob.req(`/vaults/${vault}/notes`)).status).toBe(404);
  });
});

describe("notes, links, tags and search", () => {
  test("create notes and derive the index", async () => {
    const a = await alice.ok(`/vaults/${vault}/notes`, {
      body: { path: "Alpha", content: "---\ntags: [project]\n---\n# Alpha\nPlanning the [[Beta]] launch with #urgent tasks.\n- [ ] ship it\n" },
    });
    const b = await alice.ok(`/vaults/${vault}/notes`, { body: { path: "Projects/Beta.md", content: "# Beta\nThe vector database migration to pgvector." } });
    ids.alpha = a.id;
    ids.beta = b.id;
    expect(a.tags).toEqual(["project", "urgent"]);
    expect(a.path).toBe("Alpha.md");
    expect((await alice.req(`/vaults/${vault}/notes`, { body: { path: "alpha.md" } })).status).toBe(409);
  });

  test("simultaneous creates of one path give a conflict, not a server error", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => alice.req(`/vaults/${vault}/notes`, { body: { path: "Race.md" } })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    const made = rs.find((r) => r.status === 200)!.data;
    await alice.ok(`/vaults/${vault}/notes/${made.id}`, { method: "DELETE" });
  });

  test("backlinks and outgoing links resolve by title", async () => {
    const l = await alice.ok(`/vaults/${vault}/notes/${ids.beta}/links`);
    expect(l.backlinks.map((x: any) => x.title)).toEqual(["Alpha"]);
    const o = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}/links`);
    expect(o.outgoing).toEqual([{ target: "beta", id: ids.beta, path: "Projects/Beta.md" }]);
  });

  test("keyword, tag and semantic search", async () => {
    const r = await alice.ok(`/vaults/${vault}/search?q=${encodeURIComponent("vector database")}`);
    expect(r.hits[0].title).toBe("Beta");
    expect(r.hits[0].via).toContain("keyword");
    const t = await alice.ok(`/vaults/${vault}/search?q=tag:project`);
    expect(t.hits.map((h: any) => h.title)).toEqual(["Alpha"]);
    // Semantic hits come from the chunk embeddings; wait for the debounced embed job.
    await until(async () => (await alice.ok(`/vaults/${vault}/search?q=pgvector+migration`)).hits.some((h: any) => h.via.includes("semantic")));
    const tags = await alice.ok(`/vaults/${vault}/tags`);
    expect(tags.map((t: any) => t.tag)).toEqual(["project", "urgent"]);
  });

  test("snippets are escaped", async () => {
    const n = await alice.ok(`/vaults/${vault}/notes`, { body: { path: "Xss", content: "<img src=x onerror=alert(1)> payload word" } });
    const r = await alice.ok(`/vaults/${vault}/search?q=payload`);
    expect(r.hits[0].snippet).not.toContain("<img");
    await alice.ok(`/vaults/${vault}/notes/${n.id}`, { method: "DELETE" });
  });

  test("renaming a note rewrites links to it", async () => {
    await alice.ok(`/vaults/${vault}/notes/${ids.beta}`, { method: "PATCH", body: { path: "Projects/Gamma" } });
    const a = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}`);
    expect(a.content).toContain("[[Gamma]]");
    expect(a.content).not.toContain("[[Beta]]");
  });

  test("graph has the edge", async () => {
    const g = await alice.ok(`/vaults/${vault}/graph`);
    expect(g.edges).toContainEqual({ source: ids.alpha, target: ids.beta });
  });
});

describe("sharing and roles", () => {
  test("viewer can read but not write", async () => {
    await addMember(vault, bob, "viewer");
    const n = await bob.ok(`/vaults/${vault}/notes/${ids.alpha}`);
    expect(n.role).toBe("viewer");
    expect((await bob.req(`/vaults/${vault}/notes/${ids.alpha}/content`, { method: "PUT", body: { content: "hacked" } })).status).toBe(403);
    expect((await bob.req(`/vaults/${vault}/members`, { method: "PUT", body: { email: "bob@example.com", role: "owner" } })).status).toBe(403);
  });

  test("the last owner can't be removed", async () => {
    const me = (await alice.ok("/session")).user;
    expect((await alice.req(`/vaults/${vault}/members/${me.id}`, { method: "DELETE" })).status).toBe(400);
  });
});

describe("live collaboration", () => {
  test("edits sync between users and persist; viewer edits are dropped", async () => {
    const a = alice.live(ids.alpha);
    const b = bob.live(ids.alpha); // still a viewer
    await Promise.all([a.synced, b.synced]);
    expect(b.text.toString()).toBe(a.text.toString());

    a.text.insert(a.text.length, "Live line from Alice.\n");
    await until(() => b.text.toString().includes("Live line from Alice."));

    b.text.insert(0, "VIEWER WAS HERE ");
    // Alice types after the viewer; once her line is saved, the viewer's edit had its chance.
    a.text.insert(a.text.length, "After the viewer.\n");
    await until(async () => (await alice.ok(`/vaults/${vault}/notes/${ids.alpha}`)).content.includes("After the viewer."), 10000);
    const stored = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}`);
    expect(stored.content).toContain("Live line from Alice.");
    expect(stored.content).not.toContain("VIEWER WAS HERE");

    // Awareness: Alice can see Bob's presence.
    b.provider.awareness.setLocalStateField("user", { name: "Bob" });
    await until(() => [...a.provider.awareness.getStates().values()].some((s: any) => s.user?.name === "Bob"));
    a.provider.destroy();
    b.provider.destroy();
  });

  test("edits survive a failed save after everyone leaves (database outage)", async () => {
    const n = await alice.ok(`/vaults/${vault}/notes`, { body: { path: "Outage.md", content: "before" } });
    const db = postgres(DB, { onnotice: () => {} });
    // Stand-in for the database being down: any save containing OUTAGE is rejected.
    await db`alter table notes add constraint outage check (content not like '%OUTAGE%') not valid`;
    try {
      const a = alice.live(n.id);
      await a.synced;
      a.text.insert(0, "OUTAGE edit ");
      await Bun.sleep(1200); // the debounced save runs and fails
      a.provider.destroy(); // last editor leaves while the edit is still unsaved
      await Bun.sleep(300);
    } finally {
      await db`alter table notes drop constraint if exists outage`;
      await db.end();
    }
    await until(async () => (await alice.ok(`/vaults/${vault}/notes/${n.id}`)).content.startsWith("OUTAGE edit before"), 10000);
    await alice.ok(`/vaults/${vault}/notes/${n.id}`, { method: "DELETE" });
  }, 15000);

  test("concurrent editors converge; REST writes reach open editors", async () => {
    await addMember(vault, bob, "editor");
    const a = alice.live(ids.beta);
    const b = bob.live(ids.beta);
    await Promise.all([a.synced, b.synced]);
    a.text.insert(0, "A1 ");
    b.text.insert(b.text.length, " B1");
    await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes("A1") && a.text.toString().includes("B1"));

    await alice.ok(`/vaults/${vault}/notes/${ids.beta}/content`, { method: "PUT", body: { content: a.text.toString() + "\nFrom REST" } });
    await until(() => b.text.toString().endsWith("From REST"));
    a.provider.destroy();
    b.provider.destroy();
    await until(async () => (await alice.ok(`/vaults/${vault}/notes/${ids.beta}`)).content.includes("B1"));
  });

  test("reopening after the room closed keeps one copy of the text", async () => {
    const c = alice.live(ids.beta);
    await c.synced;
    const text = c.text.toString();
    expect(text.split("From REST").length).toBe(2);
    expect((await alice.ok(`/vaults/${vault}/notes/${ids.beta}`)).content).toBe(text);
    c.provider.destroy();
  });

  test("outsiders can't open the socket", async () => {
    const eve = new Client("eve");
    await eve.ok("/register", { body: { email: "eve@example.com", password: "password-e" } });
    const res = await fetch(`${BASE}/ws/${ids.alpha}`, { headers: { cookie: eve.cookie, upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(res.status).toBe(404);
  });
});

describe("review regressions", () => {
  test("LIKE wildcards in a link don't match every note", async () => {
    const n = await alice.ok(`/vaults/${vault}/notes`, { body: { path: "Wild", content: "[[%]] [[_]]" } });
    const l = await alice.ok(`/vaults/${vault}/notes/${ids.beta}/links`);
    expect(l.backlinks.map((b: any) => b.title)).not.toContain("Wild");
    expect((await alice.req(`/vaults/${vault}/resolve?target=%25`)).status).toBe(404);
    await alice.ok(`/vaults/${vault}/notes/${n.id}`, { method: "DELETE" });
  });

  test("a zip whose entries expand past the limits is refused per entry, not inflated", async () => {
    const zip = zipSync({ "big.md": new Uint8Array(6 * 1024 * 1024).fill(97), "ok.md": strToU8("fine") });
    const form = new FormData();
    form.append("files", new File([zip], "bomb.zip"));
    form.append("folder", "Bomb");
    const r = await alice.ok(`/vaults/${vault}/import`, { form });
    expect(r.created).toBe(1);
    expect(r.errors).toEqual([{ path: "big.md", error: "too large to import" }]);
    const notes = await alice.ok(`/vaults/${vault}/notes`);
    await alice.ok(`/vaults/${vault}/notes/${notes.find((n: any) => n.path === "Bomb/ok.md").id}`, { method: "DELETE" });
  });

  test("a client can't overwrite another connection's presence", async () => {
    const a = alice.live(ids.beta);
    const b = bob.live(ids.beta);
    await Promise.all([a.synced, b.synced]);
    a.provider.awareness.setLocalStateField("user", { name: "Alice" });
    await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === "Alice");
    // Bob forges an awareness update carrying Alice's client id.
    const { Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
    const forged = new Awareness(new Y.Doc());
    (forged as any).clientID = a.doc.clientID;
    forged.setLocalState({ user: { name: "Mallory" } });
    (forged as any).meta.get(a.doc.clientID).clock = 999;
    const enc = (await import("lib0/encoding")) as any;
    const e = enc.createEncoder();
    enc.writeVarUint(e, 1);
    enc.writeVarUint8Array(e, encodeAwarenessUpdate(forged, [a.doc.clientID]));
    (b.provider as any).ws.send(enc.toUint8Array(e));
    // Bob's next, honest update travels on the same socket, so once Alice sees it the server has
    // handled the forged one.
    b.provider.awareness.setLocalStateField("user", { name: "Bob, after" });
    await until(() => a.provider.awareness.getStates().get(b.doc.clientID)?.user?.name === "Bob, after");
    const c = alice.live(ids.beta);
    await c.synced;
    await until(() => c.provider.awareness.getStates().get(b.doc.clientID)?.user?.name === "Bob, after");
    expect(c.provider.awareness.getStates().get(a.doc.clientID)?.user?.name).toBe("Alice");
    [a, b, c].forEach((x) => x.provider.destroy());
  });

  test("signing out closes that session's live sockets", async () => {
    const carol = new Client("carol");
    await carol.ok("/register", { body: { email: "carol@example.com", password: "password-c" } });
    await addMember(vault, carol, "editor");
    const s = carol.live(ids.beta);
    await s.synced;
    const closed = new Promise<number>((r) => s.provider.on("connection-close", (e: any) => r(e?.code)));
    await carol.ok("/logout", { method: "POST" });
    expect(await closed).toBe(4403);
    s.provider.destroy();
  });
});

describe("history", () => {
  test("restore brings back earlier text", async () => {
    await alice.ok(`/vaults/${vault}/notes/${ids.alpha}/content`, { method: "PUT", body: { content: "temporary text" } });
    const revs = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}/revisions`);
    expect(revs.length).toBeGreaterThan(0);
    const before = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}/revisions/${revs[0].id}`);
    expect(before.content).toContain("Alpha");
    const restored = await alice.ok(`/vaults/${vault}/notes/${ids.alpha}/revisions/${revs[0].id}`, { method: "POST" });
    expect(restored.content).toBe(before.content);
  });
});

describe("import and export", () => {
  test("a vault zip of Markdown files imports with folders, attachments and links", async () => {
    const zip = zipSync({
      "MyVault/.obsidian/app.json": strToU8("{}"),
      "MyVault/Home.md": strToU8("Welcome. See [[Ideas/Garden]] and ![[assets/pic.png]]\r\n"),
      "MyVault/Ideas/Garden.md": strToU8("﻿#garden tomatoes"),
      "MyVault/assets/pic.png": new Uint8Array([137, 80, 78, 71]),
      "MyVault/.trash/old.md": strToU8("gone"),
    });
    const form = new FormData();
    form.append("files", new File([zip], "MyVault.zip"));
    form.append("folder", "Imported");
    const r = await alice.ok(`/vaults/${vault}/import`, { form });
    expect(r).toMatchObject({ created: 2, attachments: 1, errors: [] });
    const notes = await alice.ok(`/vaults/${vault}/notes`);
    const home = notes.find((n: any) => n.path === "Imported/Home.md");
    expect(home).toBeTruthy();
    const full = await alice.ok(`/vaults/${vault}/notes/${home.id}`);
    expect(full.content).not.toContain("\r");
    const links = await alice.ok(`/vaults/${vault}/notes/${home.id}/links`);
    expect(links.outgoing[0].path).toBe("Imported/Ideas/Garden.md");
    const file = await alice.req(`/vaults/${vault}/files?path=pic.png`);
    expect(file.status).toBe(200);
  });

  test("re-import with skip leaves notes alone; overwrite updates them", async () => {
    const md = (s: string) => {
      const f = new FormData();
      f.append("files", new File([s], "Alpha.md"));
      return f;
    };
    const skip = md("replaced");
    skip.append("mode", "skip");
    expect((await alice.ok(`/vaults/${vault}/import`, { form: skip })).skipped).toBe(1);
    const over = md("replaced");
    over.append("mode", "overwrite");
    expect((await alice.ok(`/vaults/${vault}/import`, { form: over })).updated).toBe(1);
    expect((await alice.ok(`/vaults/${vault}/notes/${ids.alpha}`)).content).toBe("replaced");
  });

  test("export is a zip of the vault as markdown", async () => {
    const r = await bob.req(`/vaults/${vault}/export`);
    expect(r.status).toBe(200);
    const files = unzipSync(r.data);
    expect(Object.keys(files).sort()).toEqual(["Alpha.md", "Imported/Home.md", "Imported/Ideas/Garden.md", "Imported/assets/pic.png", "Projects/Gamma.md"]);
    expect(strFromU8(files["Alpha.md"]!)).toBe("replaced");
    const one = await bob.req(`/vaults/${vault}/notes/${ids.alpha}/export`);
    expect(strFromU8(one.data)).toBe("replaced");
  });
});

describe("admin", () => {
  test("deleting a user hands their sole-owner vaults to the admin", async () => {
    const users = await alice.ok("/admin/users");
    const eve = users.find((u: any) => u.email === "eve@example.com");
    expect((await bob.req("/admin/users")).status).toBe(403);
    await alice.ok(`/admin/users/${eve.id}`, { method: "DELETE" });
    const vs = await alice.ok("/vaults");
    expect(vs.some((v: any) => v.name.startsWith("eve"))).toBe(true);
  });
});

describe("folders", () => {
  let fv: number;
  test("an empty folder can be created and is listed", async () => {
    fv = (await alice.ok("/vaults", { body: { name: "Folders" } })).id;
    expect(await alice.ok(`/vaults/${fv}/folders`, { body: { path: " Projects/ " } })).toEqual({ path: "Projects" });
    expect(await alice.ok(`/vaults/${fv}/folders`)).toEqual(["Projects"]);
    expect((await alice.req(`/vaults/${fv}/folders`, { body: { path: "projects" } })).status).toBe(409);
    expect((await alice.req(`/vaults/${fv}/folders`, { body: { path: "../x" } })).status).toBe(400);
    // A folder implied by a note already exists too.
    await alice.ok(`/vaults/${fv}/notes`, { body: { path: "Areas/Home.md" } });
    expect((await alice.req(`/vaults/${fv}/folders`, { body: { path: "Areas" } })).status).toBe(409);
  });

  test("non-members can't see or create folders", async () => {
    expect((await bob.req(`/vaults/${fv}/folders`)).status).toBe(404);
    expect((await bob.req(`/vaults/${fv}/folders`, { body: { path: "Sneaky" } })).status).toBe(404);
  });

  test("rename moves an empty folder and its subfolders", async () => {
    await alice.ok(`/vaults/${fv}/folders`, { body: { path: "Projects/Kitchen" } });
    await alice.ok(`/vaults/${fv}/folders/rename`, { body: { from: "Projects", to: "Work" } });
    expect(await alice.ok(`/vaults/${fv}/folders`)).toEqual(["Work", "Work/Kitchen"]);
  });

  test("a folder can't move inside itself or onto an existing folder", async () => {
    expect((await alice.req(`/vaults/${fv}/folders/rename`, { body: { from: "Work", to: "Work/Kitchen/Work" } })).status).toBe(400);
    await alice.ok(`/vaults/${fv}/folders`, { body: { path: "Archive/Work" } });
    expect((await alice.req(`/vaults/${fv}/folders/rename`, { body: { from: "Work", to: "archive/work" } })).status).toBe(409);
    await alice.ok(`/vaults/${fv}/folders?path=Archive/Work`, { method: "DELETE" });
    // Dragging a note into a folder is a rename of its path.
    const n = await alice.ok(`/vaults/${fv}/notes`, { body: { path: "Loose.md" } });
    expect((await alice.ok(`/vaults/${fv}/notes/${n.id}`, { method: "PATCH", body: { path: "Archive/Loose.md" } })).path).toBe("Archive/Loose.md");
  });

  test("only an empty folder can be deleted", async () => {
    await alice.ok(`/vaults/${fv}/notes`, { body: { path: "Work/Plan.md" } });
    expect((await alice.req(`/vaults/${fv}/folders?path=Work`, { method: "DELETE" })).status).toBe(409);
    await alice.ok(`/vaults/${fv}/folders?path=Work/Kitchen`, { method: "DELETE" });
    expect(await alice.ok(`/vaults/${fv}/folders`)).toEqual(["Work"]);
    expect((await alice.req(`/vaults/${fv}/folders?path=Nope`, { method: "DELETE" })).status).toBe(404);
  });

  test("empty folders round-trip through export and import", async () => {
    await alice.ok(`/vaults/${fv}/folders`, { body: { path: "Someday/Maybe" } });
    const r = await alice.req(`/vaults/${fv}/export`);
    const names = Object.keys(unzipSync(r.data));
    expect(names).toContain("Someday/Maybe/");
    const target = (await alice.ok("/vaults", { body: { name: "Restored" } })).id;
    const form = new FormData();
    form.append("files", new File([r.data], "Folders.zip"));
    await alice.ok(`/vaults/${target}/import`, { form });
    const restored = await alice.ok(`/vaults/${target}/folders`);
    expect(restored).toContain("Someday/Maybe");
    expect(restored.some((f: string) => f.startsWith("."))).toBe(false);
  });
});

describe("trash", () => {
  let tv: number;
  let noteId: number;
  test("deleting moves a note to Trash, including unsaved live edits", async () => {
    tv = (await alice.ok("/vaults", { body: { name: "Trash test" } })).id;
    const n = await alice.ok(`/vaults/${tv}/notes`, { body: { path: "Plans/Kitchen.md", content: "v1" } });
    await alice.ok(`/vaults/${tv}/notes`, { body: { path: "Linker.md", content: "See [[Kitchen]]" } });
    await alice.ok(`/vaults/${tv}/notes/${n.id}/content`, { method: "PUT", body: { content: "v2" } });
    const a = alice.live(n.id);
    await a.synced;
    a.text.insert(a.text.length, " UNSAVED"); // deleted before the debounced save runs
    await Bun.sleep(50);
    const { trashId } = await alice.ok(`/vaults/${tv}/notes/${n.id}`, { method: "DELETE" });
    a.provider.destroy();
    expect((await alice.req(`/vaults/${tv}/notes/${n.id}`)).status).toBe(404);
    const t = await alice.ok(`/vaults/${tv}/trash`);
    expect(t.days).toBe(30);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ path: "Plans/Kitchen.md", title: "Kitchen", deleted_by_name: "Alice" });
    expect(t.items[0].id).toBe(trashId); // the delete response names the Trash entry, for Undo
    const [row] = await testDb`select content from trashed_notes where id = ${t.items[0].id}`;
    expect(row!.content).toBe("v2 UNSAVED");
    // Gone from search and links while trashed.
    const linker = (await alice.ok(`/vaults/${tv}/notes`)).find((x: any) => x.path === "Linker.md");
    expect((await alice.ok(`/vaults/${tv}/notes/${linker.id}/links`)).outgoing[0].id).toBeNull();
  });

  test("restore brings the note back with its history; a taken path gets a suffix", async () => {
    await alice.ok(`/vaults/${tv}/notes`, { body: { path: "Plans/Kitchen.md", content: "a new note in its place" } });
    const [{ id: trashId }] = (await alice.ok(`/vaults/${tv}/trash`)).items;
    const restored = await alice.ok(`/vaults/${tv}/trash/${trashId}/restore`, { method: "POST" });
    noteId = restored.id;
    expect(restored.path).toBe("Plans/Kitchen 1.md");
    expect(restored.content).toBe("v2 UNSAVED");
    const revs = await alice.ok(`/vaults/${tv}/notes/${noteId}/revisions`);
    expect(revs.length).toBeGreaterThanOrEqual(1);
    expect((await alice.ok(`/vaults/${tv}/trash`)).items).toHaveLength(0);
    // It opens live with the same text (the CRDT state came back too).
    const a = alice.live(noteId);
    await a.synced;
    expect(a.text.toString()).toBe("v2 UNSAVED");
    a.provider.destroy();
  });

  test("delete forever, empty Trash (owner only), and access rules", async () => {
    await alice.ok(`/vaults/${tv}/notes/${noteId}`, { method: "DELETE" });
    const [{ id: t1 }] = (await alice.ok(`/vaults/${tv}/trash`)).items;
    expect((await bob.req(`/vaults/${tv}/trash`)).status).toBe(404); // not a member
    await alice.ok(`/vaults/${tv}/trash/${t1}`, { method: "DELETE" });
    expect((await alice.req(`/vaults/${tv}/trash/${t1}/restore`, { method: "POST" })).status).toBe(404);
    const other = (await alice.ok(`/vaults/${tv}/notes`))[0];
    await alice.ok(`/vaults/${tv}/notes/${other.id}`, { method: "DELETE" });
    await addMember(tv, bob, "editor");
    expect((await bob.req(`/vaults/${tv}/trash`, { method: "DELETE" })).status).toBe(403);
    expect((await alice.ok(`/vaults/${tv}/trash`, { method: "DELETE" })).deleted).toBe(1);
  });

  test("notes trashed more than 30 days ago are purged", async () => {
    const n = await alice.ok(`/vaults/${tv}/notes`, { body: { path: "Old.md", content: "old" } });
    await alice.ok(`/vaults/${tv}/notes/${n.id}`, { method: "DELETE" });
    await testDb`update trashed_notes set deleted_at = now() - interval '31 days' where vault_id = ${tv}`;
    const p = Bun.spawn(["bun", "-e", "const { purgeTrash } = await import('./src/notes.ts'); console.log(await purgeTrash()); process.exit(0)"], {
      env: { ...process.env, DATABASE_URL: DB },
      stdout: "pipe",
    });
    expect((await new Response(p.stdout).text()).trim()).toBe("1");
    expect((await alice.ok(`/vaults/${tv}/trash`)).items).toHaveLength(0);
  });
});

describe("admin storage", () => {
  test("admins see database usage; others can't", async () => {
    const s = await alice.ok("/admin/storage");
    expect(s.database).toBeGreaterThan(0);
    for (const k of ["attachments", "notes", "revisions", "trash"]) expect(typeof s[k]).toBe("number");
    expect(s).toMatchObject({ limit: 1024 ** 3, warnAt: 0.8, fullAt: 0.9 }); // DB_DISK_GB unset: 1 GB
    expect((await bob.req("/admin/storage")).status).toBe(403);
    expect((await alice.ok("/session")).storage).toMatchObject({ state: "ok", limit: 1024 ** 3 });
    expect((await bob.ok("/session")).storage).toBeUndefined();
  });

  test("REST refuses a note over 5 MB", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    expect((await alice.req(`/vaults/${vault}/notes`, { body: { path: "Huge.md", content: big } })).status).toBe(400);
  });
});

describe("aliases and ids (F9 step 1)", () => {
  test("a link by alias or id reaches the note: backlinks, graph and resolve", async () => {
    const av = (await alice.ok("/vaults", { body: { name: "Aliases" } })).id;
    const sam = await alice.ok(`/vaults/${av}/notes`, { body: { path: "People/Samuel Okafor.md", content: "---\naliases: [Sam, Sammy]\nid: sam-okafor\n---\n# Samuel Okafor\n" } });
    const one = await alice.ok(`/vaults/${av}/notes`, { body: { path: "Diary.md", content: "Rang [[Sam]] and [[sammy|him]]. Also [[sam-okafor]]." } });
    const solo = await alice.ok(`/vaults/${av}/notes`, { body: { path: "Solo.md", content: "---\naliases: Lone\n---\n" } });
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Other.md", content: "See [[Lone]] and [[Nobody]]." } });
    const back = await alice.ok(`/vaults/${av}/notes/${sam.id}/links`);
    expect(JSON.stringify(back)).toContain("Diary");
    const graph = await alice.ok(`/vaults/${av}/graph`);
    expect(graph.edges).toContainEqual({ source: one.id, target: sam.id });
    expect(graph.edges.some((e: any) => e.target === solo.id)).toBe(true);
    expect((await alice.ok(`/vaults/${av}/resolve?target=Sam`)).id).toBe(sam.id);
    expect((await alice.ok(`/vaults/${av}/resolve?target=sam-okafor`)).id).toBe(sam.id);
    // A title still wins over someone else's alias.
    const real = await alice.ok(`/vaults/${av}/notes`, { body: { path: "Sam.md", content: "# Sam the dog\n" } });
    expect((await alice.ok(`/vaults/${av}/resolve?target=Sam`)).id).toBe(real.id);
    const list = await alice.ok(`/vaults/${av}/notes`);
    expect(list.find((n: any) => n.id === sam.id).aliases.sort()).toEqual(["sam", "sam-okafor", "sammy"]);
    expect(list.find((n: any) => n.path === "Other.md").aliases).toBeNull();
  });
});

describe("the tour", () => {
  test("adds its notes and the Person type to a new vault once; links between them resolve", async () => {
    const tv = (await alice.ok("/vaults", { body: { name: "Tour test" } })).id;
    const { id } = await alice.ok(`/vaults/${tv}/tour`, { body: {} });
    const list = await alice.ok(`/vaults/${tv}/notes`);
    expect(list.map((n: any) => n.path).sort()).toEqual(["Tour/Ada Lovelace.md", "Tour/Links and backlinks.md", "Tour/Start here.md", "Tour/Things, not files.md", "Tour/Writing well.md", "Types/Person.md"]);
    expect(list.find((n: any) => n.id === id).path).toBe("Tour/Start here.md");
    expect(list.find((n: any) => n.path === "Tour/Ada Lovelace.md").type).toBe("Person");
    const links = await alice.ok(`/vaults/${tv}/notes/${list.find((n: any) => n.path === "Tour/Links and backlinks.md").id}/links`);
    expect(JSON.stringify(links)).toContain("Start here");
    expect((await alice.ok(`/vaults/${tv}/tour`, { body: {} })).id).toBe(id); // a second time changes nothing
    expect(await alice.ok(`/vaults/${tv}/notes`)).toHaveLength(6);
    expect((await bob.req(`/vaults/${tv}/tour`, { body: {} })).status).toBe(404);
  });
});

describe("publish a vault as a website (F18)", () => {
  const get = (path: string) => fetch(`${BASE}${path}`, { redirect: "manual" });
  let pv = 0;
  let slug = "";
  const upload = (name: string, folder: string) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: "image/png" }));
    form.append("folder", folder);
    return alice.ok(`/vaults/${pv}/files`, { form });
  };

  test("chosen folders become pages with links between them; nothing left out can be reached", async () => {
    pv = (await alice.ok("/vaults", { body: { name: "Garden site" } })).id;
    const note = (path: string, content: string) => alice.ok(`/vaults/${pv}/notes`, { body: { path, content } });
    await note(
      "Garden/Roses.md",
      "---\nsecret: hidden-property-value\n---\n# Roses\n\nPrune in [[Winter jobs]], mulch as in [[Winter jobs#Mulch]]. Feed from [[Heap|the heap]]; notes in [[Monday]].\n\n![[rose.png]]\n\n%%private remark%%\n\n<script>alert(1)</script><span style=\"color:red\" onclick=\"x()\">red</span>\n\n[bad](javascript:alert(1))\n\n- [x] Feed\n",
    );
    await note("Garden/Winter jobs.md", "## Mulch\n\nSpread it thick.\n");
    await note("Garden/Compost plan.md", "---\npublish: false\naliases: [Heap]\n---\nKeep this private.\n\n![[heap.png]]\n");
    await note("Diary/Monday.md", "Private diary.");
    await upload("rose.png", "Garden");
    await upload("heap.png", "attachments");

    // A new vault publishes everything until folders are chosen; the choice is publish.json.
    expect((await alice.ok(`/vaults/${pv}/site`)).noteCount).toBe(3);
    expect(await alice.ok(`/vaults/${pv}/site/settings`, { method: "PUT", body: { include: ["Garden"] } })).toEqual({ include: ["Garden"] });
    const state = await alice.ok(`/vaults/${pv}/site`);
    expect(state).toMatchObject({ notes: ["Garden/Roses.md", "Garden/Winter jobs.md"], held: ["Garden/Compost plan.md"], files: ["Garden/rose.png"], site: null, changes: null, folders: ["Diary", "Garden"] });

    const out = await alice.ok(`/vaults/${pv}/site/publish`, { body: {} });
    expect(out).toMatchObject({ pages: 2, files: 1 });
    slug = out.slug;
    expect((await get(`/p/${slug}`)).headers.get("location")).toBe(`/p/${slug}/`);

    const roses = await get(`/p/${slug}/Garden/Roses`);
    expect(roses.status).toBe(200);
    expect(roses.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(roses.headers.get("content-security-policy")).toContain("sandbox");
    expect(roses.headers.get("x-robots-tag")).toContain("noindex");
    const html = await roses.text();
    expect(html).toContain(`href="../Garden/Winter%20jobs"`);
    expect(html).toContain(`href="../Garden/Winter%20jobs#mulch"`);
    expect(html).toContain(`<img src="../Garden/rose.png"`);
    expect(html).toContain("the heap"); // the words the note uses, as plain text
    expect(html).toContain("<span>red</span>");
    for (const leak of ["Compost", "Keep this private", "Private diary", "Diary/Monday", "private remark", "hidden-property-value", "<script", "onclick", "style=", "javascript:"]) expect(html).not.toContain(leak);
    expect(html.match(/<h1/g)).toHaveLength(1); // the title, not repeated by the note's own heading

    const winter = await (await get(`/p/${slug}/Garden/Winter%20jobs`)).text();
    expect(winter).toContain(`<h2 id="mulch">`);
    expect((await get(`/p/${slug}/Garden/rose.png`)).headers.get("content-type")).toBe("image/png");
    expect((await get(`/p/${slug}/_site/style.css`)).headers.get("content-type")).toContain("text/css");
    const list = await (await get(`/p/${slug}/`)).text();
    expect(list).toContain("Roses");
    expect(list).not.toContain("Compost");

    // Left out, unknown and outside: the same 404, saying nothing about what exists.
    const missing = await (await get(`/p/${slug}/Nothing/Here`)).text();
    for (const path of ["Garden/Compost%20plan", "Diary/Monday", "attachments/heap.png", "publish.json", "Garden/Roses.md"]) {
      const r = await get(`/p/${slug}/${path}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(missing);
    }
    expect((await get(`/p/nosuchsite1/`)).status).toBe(404);
  });

  test("only owners publish; outsiders can't see the settings", async () => {
    expect((await bob.req(`/vaults/${pv}/site`)).status).toBe(404);
    await addMember(pv, bob, "editor");
    expect((await bob.req(`/vaults/${pv}/site`)).status).toBe(200);
    expect((await bob.req(`/vaults/${pv}/site/publish`, { body: {} })).status).toBe(403);
    expect((await bob.req(`/vaults/${pv}/site/settings`, { method: "PUT", body: { include: [] } })).status).toBe(403);
    expect((await bob.req(`/vaults/${pv}/site/live`, { method: "PUT", body: { live: false } })).status).toBe(403);
  });

  test("edits stay private until republished, and the settings list what would change", async () => {
    const list = await alice.ok(`/vaults/${pv}/notes`);
    const byPath = (p: string) => list.find((n: any) => n.path === p).id;
    await alice.ok(`/vaults/${pv}/notes/${byPath("Garden/Winter jobs.md")}/content`, { method: "PUT", body: { content: "## Mulch\n\nSpread it thin.\n" } });
    await alice.ok(`/vaults/${pv}/notes/${byPath("Garden/Roses.md")}/content`, { method: "PUT", body: { content: "---\npublish: false\n---\nGone." } });
    await alice.ok(`/vaults/${pv}/notes`, { body: { path: "Garden/Tulips.md", content: "Plant in [[Winter jobs|autumn]]." } });
    expect(await (await get(`/p/${slug}/Garden/Winter%20jobs`)).text()).toContain("thick");

    const { changes } = await alice.ok(`/vaults/${pv}/site`);
    expect(changes).toEqual({ added: ["Garden/Tulips.md"], changed: ["Garden/Winter jobs.md"], removed: ["Garden/Roses.md"], settings: false });

    expect((await alice.ok(`/vaults/${pv}/site/publish`, { body: {} })).slug).toBe(slug);
    expect(await (await get(`/p/${slug}/Garden/Winter%20jobs`)).text()).toContain("thin");
    expect((await get(`/p/${slug}/Garden/Roses`)).status).toBe(404);
    expect((await get(`/p/${slug}/Garden/rose.png`)).status).toBe(404); // no published page shows it now
    expect(await (await get(`/p/${slug}/Garden/Tulips`)).text()).toContain(`href="../Garden/Winter%20jobs">autumn</a>`);
    expect((await alice.ok(`/vaults/${pv}/site`)).changes).toEqual({ added: [], changed: [], removed: [], settings: false });
  });

  test("taking the site down hides every page at once; Undo puts the same pages back", async () => {
    await alice.ok(`/vaults/${pv}/site/live`, { method: "PUT", body: { live: false } });
    expect((await get(`/p/${slug}/Garden/Tulips`)).status).toBe(404);
    expect((await get(`/p/${slug}/`)).status).toBe(404);
    expect((await alice.ok(`/vaults/${pv}/site`)).site).toMatchObject({ slug, live: false, pages: 2 });
    await alice.ok(`/vaults/${pv}/site/live`, { method: "PUT", body: { live: true } });
    expect((await get(`/p/${slug}/Garden/Tulips`)).status).toBe(200);
  });

  test("Dataview results are worked out at Publish, from published notes only, with no script", async () => {
    const note = (path: string, content: string) => alice.ok(`/vaults/${pv}/notes`, { body: { path, content } });
    await note("Garden/Index.md", '# Index\n\nPages: `= length(dv.pages(""))`\n\n```dataview\nLIST FROM ""\n```\n\n```dataview\nTASK FROM ""\n```\n');
    await note("Diary/Tuesday.md", "- [ ] Private task\n");
    await note("Garden/Calendar.md", '```dataview\nCALENDAR file.cday FROM ""\n```\n');
    await alice.ok(`/vaults/${pv}/site/publish`, { body: {} });
    const html = await (await get(`/p/${slug}/Garden/Index`)).text();
    expect(html).toContain(`href="../Garden/Tulips">Tulips</a>`);
    expect(html).toContain(`href="../Garden/Winter%20jobs">Winter jobs</a>`);
    expect(html).toContain('<span class="dataview-inline">4</span>'); // Calendar, Index, Tulips, Winter jobs
    for (const leak of ["Diary", "Monday", "Tuesday", "Private task", "Compost", "Roses"]) expect(html).not.toContain(leak);
    expect(html).not.toContain("<script");
    // A calendar is every month it has, without buttons (the page runs no script).
    const cal = await (await get(`/p/${slug}/Garden/Calendar`)).text();
    expect(cal).toContain('class="dv-calendar"');
    expect(cal).toContain(`href="../Garden/Tulips">Tulips</a>`);
    expect(cal).not.toContain("<button");
    for (const leak of ["Diary/", "Private task"]) expect(cal).not.toContain(leak);
  });

  test("the Dataview route answers members, as the vault is, and nobody else", async () => {
    const list = await alice.ok(`/vaults/${pv}/notes`);
    const index = list.find((n: any) => n.path === "Garden/Index.md").id;
    const items = [
      { kind: "query", source: 'TABLE WITHOUT ID file.name FROM "Diary" SORT file.name' },
      { kind: "inline", source: "this.file.name" },
      { kind: "query", source: "TABLE oops(" },
    ];
    const r = await bob.ok(`/vaults/${pv}/dataview`, { body: { noteId: index, offset: 60, items } });
    expect(r[0]).toMatchObject({ kind: "table", rows: [["Monday"], ["Tuesday"]], total: 2 });
    expect(r[1]).toEqual({ kind: "value", value: "Index" });
    expect(r[2]).toMatchObject({ kind: "error" });
    const outsider = new Client("dv-outsider");
    await outsider.ok("/register", { body: { email: "dv-outsider@example.com", password: "password-o" } });
    expect((await outsider.req(`/vaults/${pv}/dataview`, { body: { noteId: index, offset: 0, items } })).status).toBe(404);
  });

  test("publish.json travels with an export; a broken one publishes nothing rather than everything", async () => {
    const zip = unzipSync((await alice.req(`/vaults/${pv}/export`)).data);
    expect(JSON.parse(strFromU8(zip["publish.json"]!))).toEqual({ include: ["Garden"] });
    await testDb`update attachments set data = ${Buffer.from("{ not json")} where vault_id = ${pv} and path = 'publish.json'`;
    const r = await alice.req(`/vaults/${pv}/site/publish`, { body: {} });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("publish.json isn't valid");
    expect((await get(`/p/${slug}/Garden/Tulips`)).status).toBe(200); // the last good snapshot stays up
    expect((await alice.ok(`/vaults/${pv}/site/settings`, { method: "PUT", body: { include: ["Garden"] } })).include).toEqual(["Garden"]);
  });
});

describe("saved searches", () => {
  test("are each person's own, unique, and need a query", async () => {
    expect(await alice.ok(`/vaults/${vault}/searches`, { body: { query: " tag:home " } })).toEqual([{ id: expect.any(Number), query: "tag:home" }]);
    expect(await alice.ok(`/vaults/${vault}/searches`, { body: { query: "tag:home" } })).toHaveLength(1);
    expect((await alice.req(`/vaults/${vault}/searches`, { body: { query: "  " } })).status).toBe(400);
    expect(await bob.ok(`/vaults/${vault}/searches`)).toEqual([]);
    const [s] = await alice.ok(`/vaults/${vault}/searches`);
    await bob.ok(`/vaults/${vault}/searches/${s.id}`, { method: "DELETE" }); // not Bob's: nothing happens
    expect(await alice.ok(`/vaults/${vault}/searches`)).toHaveLength(1);
    expect(await alice.ok(`/vaults/${vault}/searches/${s.id}`, { method: "DELETE" })).toEqual([]);
  });
});

describe("backup", () => {
  const get = (auth?: string, cookie = "") => fetch(`${BASE}/api/backup`, { headers: { ...(auth ? { authorization: auth } : {}), cookie } });
  test("needs the bearer token; a session cookie isn't enough", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("Bearer wrong")).status).toBe(401);
    expect((await get(undefined, alice.cookie)).status).toBe(401);
  });

  test("returns every vault as markdown plus a JSON sidecar with members, history and Trash", async () => {
    const r = await get("Bearer test-backup-token");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
    const names = Object.keys(files);
    const vaults = await alice.ok("/vaults");
    for (const v of vaults) expect(names.some((n) => n.startsWith(`${v.id} `) && n.endsWith(".json"))).toBe(true);
    const main = names.find((n) => n.startsWith(`${vault} `) && n.endsWith(".json"))!;
    const meta = JSON.parse(strFromU8(files[main]!));
    expect(meta.members.map((m: any) => m.email)).toContain("alice@example.com");
    expect(Array.isArray(meta.history)).toBe(true);
    expect(meta.history.some((h: any) => h.revisions.length > 0)).toBe(true);
    expect(names).toContain(`${main.slice(0, -5)}/Alpha.md`);
  });

  test("a backup restores into an empty database, note for note, with history and Trash", async () => {
    const zip = new Uint8Array(await (await get("Bearer test-backup-token")).arrayBuffer());
    const dir = `${import.meta.dir}/../.restore-test`;
    await Bun.write(`${dir}/backup.zip`, zip);
    const RESTORE_DB = DB.replace(/\/[^/]*$/, "/commonplace_restore_test");
    await testDb.unsafe("drop database if exists commonplace_restore_test");
    await testDb.unsafe("create database commonplace_restore_test");
    const run = Bun.spawnSync(["bun", "scripts/restore.ts", `${dir}/backup.zip`, "--owner", "alice@example.com"], {
      env: { ...process.env, DATABASE_URL: RESTORE_DB, EMBEDDING_PROVIDER: "none" },
    });
    await Bun.$`rm -rf ${dir}`;
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("Created alice@example.com (admin)");
    const restored = postgres(RESTORE_DB, { onnotice: () => {} });
    try {
      const shape = async (db: postgres.Sql) =>
        (await db`select v.name, n.path, md5(n.content) as h from notes n join vaults v on v.id = n.vault_id order by v.id, n.path`).map((r) => `${r.name}|${r.path}|${r.h}`);
      expect(await shape(restored)).toEqual(await shape(testDb));
      const files = async (db: postgres.Sql) => (await db`select v.name, a.path, md5(a.data) as h from attachments a join vaults v on v.id = a.vault_id order by v.id, a.path`).map((r) => `${r.name}|${r.path}|${r.h}`);
      expect(await files(restored)).toEqual(await files(testDb));
      const count = async (db: postgres.Sql, t: string) => Number((await db.unsafe(`select count(*) as n from ${t}`))[0]!.n);
      for (const t of ["note_revisions", "trashed_notes", "folders"]) expect(await count(restored, t)).toBe(await count(testDb, t));
    } finally {
      await restored.end();
      await testDb.unsafe("drop database if exists commonplace_restore_test");
    }
  });
});

describe("capture from the iPhone", () => {
  let cv: number;
  let token = "";
  let tokenId = 0;
  const share = (body: BodyInit, headers: Record<string, string> = {}, auth = token) =>
    fetch(`${BASE}/api/capture`, { method: "POST", headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }, body }); // no Origin, like a Shortcut
  const inbox = async () => {
    const n = (await alice.ok(`/vaults/${cv}/notes`)).find((x: any) => x.path === "Inbox.md");
    return n ? ((await alice.ok(`/vaults/${cv}/notes/${n.id}`)).content as string) : null;
  };

  test("a token is made while signed in, shown once, and listed without its value", async () => {
    cv = (await alice.ok("/vaults", { body: { name: "Capture" } })).id;
    const made = await alice.ok("/me/tokens", { body: { vaultId: cv, name: "Alice's iPhone" } });
    token = made.token;
    tokenId = made.row.id;
    expect(token).toMatch(/^cpc_[\w-]{40,}$/);
    expect(made.row).toMatchObject({ name: "Alice's iPhone", vault_name: "Capture", note_path: "Inbox.md" });
    const list = await alice.ok("/me/tokens");
    expect(JSON.stringify(list)).not.toContain(token);
    const [row] = await testDb`select token_hash from api_tokens where id = ${tokenId}`;
    expect(row!.token_hash).not.toBe(token); // only the hash is stored
    expect((await bob.req("/me/tokens")).data).toEqual([]); // Bob sees only his own
  });

  test("no token, a wrong one, or one in the URL is refused", async () => {
    expect((await share("hello", {}, "")).status).toBe(401);
    expect((await share("hello", {}, "cpc_wrong")).status).toBe(401);
    const inUrl = await fetch(`${BASE}/api/capture?token=${token}`, { method: "POST", body: "hello" });
    expect(inUrl.status).toBe(401);
    expect(await inbox()).toBeNull();
  });

  test("a shared link becomes a Weblink note, and a to-do linking to it in a new Inbox note", async () => {
    const form = new FormData();
    form.append("item", "https://example.com/guides/tiling");
    form.append("title", "How to tile [a] kitchen");
    const r = await share(form);
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out).toMatchObject({ ok: true, added: 1, message: "Saved it to Inbox" });
    const text = (await inbox())!;
    expect(text).toStartWith("# Inbox\n");
    expect(text).toMatch(/\n- \[ \] \[\[Weblinks\/How to tile a kitchen\|How to tile a kitchen\]\] · \d{1,2} \w{3} \d\d:\d\d\n$/);
    // The page couldn't be fetched (tests stay offline), so the note keeps the address and title.
    const w = (await alice.ok(`/vaults/${cv}/notes`)).find((n: any) => n.path === "Weblinks/How to tile a kitchen.md");
    expect(w.type).toBe("Weblink");
    expect((await alice.ok(`/vaults/${cv}/notes/${w.id}`)).frontmatter).toMatchObject({ type: "Weblink", url: "https://example.com/guides/tiling", site: "example.com" });
  });

  test("text appends below, multi-line text stays in its item, and a link without a title gets one", async () => {
    await share(JSON.stringify({ text: "Ring the electrician\nabout the hob" }), { "content-type": "application/json" });
    await share("https://www.bbc.co.uk/news/");
    const lines = (await inbox())!.trimEnd().split("\n");
    expect(lines.at(-3)).toMatch(/^- \[ \] Ring the electrician · /);
    expect(lines.at(-2)).toBe("  about the hob");
    expect(lines.at(-1)).toMatch(/^- \[ \] \[\[Weblinks\/bbc\.co\.uk news\|bbc\.co\.uk news\]\] · /);
  });

  test("a photo is stored as an attachment and embedded", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("item", new File([png], "image", { type: "image/png" })); // Shortcuts may send no extension
    const out = await (await share(form)).json();
    expect(out).toMatchObject({ added: 1 });
    const embed = /!\[\[(attachments\/[^\]]+\.png)\]\]/.exec((await inbox())!);
    expect(embed).not.toBeNull();
    const [a] = await testDb`select mime from attachments where vault_id = ${cv} and path = ${embed![1]!}`;
    expect(a!.mime).toBe("image/png");
  });

  test("the Shortcut's form: a photo plus its name sends just the photo; errors carry a message", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("item", "IMG_0042");
    form.append("url", "");
    form.append("photo", new File([png], "IMG_0042.png", { type: "image/png" }));
    expect((await (await share(form)).json()).added).toBe(1);
    const text = (await inbox())!;
    expect(text).toContain("![[attachments/IMG_0042.png]]");
    expect(text).not.toMatch(/\] IMG_0042 ·/);
    const empty = new FormData();
    empty.append("item", "  ");
    const r = await share(empty);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain("Nothing to save");
  });

  test("an append merges with someone typing in the inbox live", async () => {
    const n = (await alice.ok(`/vaults/${cv}/notes`)).find((x: any) => x.path === "Inbox.md");
    const a = alice.live(n.id);
    await a.synced;
    a.text.insert(0, "TYPING ");
    await reachedServer(alice, n.id, "TYPING ");
    expect((await share("from the phone")).status).toBe(200);
    await until(async () => (await inbox())!.includes("from the phone") && (await inbox())!.startsWith("TYPING # Inbox"));
    expect(a.text.toString()).toContain("from the phone");
    a.provider.destroy();
  });

  test("a token stops working when revoked, or when its owner can no longer edit the vault", async () => {
    await addMember(cv, bob, "editor");
    const bobs = await bob.ok("/me/tokens", { body: { vaultId: cv, name: "Bob's phone", notePath: "Bob/Inbox" } });
    expect(bobs.row.note_path).toBe("Bob/Inbox.md");
    expect((await share("ok", {}, bobs.token)).status).toBe(200);
    await alice.ok(`/vaults/${cv}/members`, { method: "PUT", body: { email: "bob@example.com", role: "viewer" } });
    expect((await share("not any more", {}, bobs.token)).status).toBe(403);
    expect((await bob.req(`/me/tokens/${tokenId}`, { method: "DELETE" })).status).toBe(404); // not his to revoke
    await alice.ok(`/me/tokens/${tokenId}`, { method: "DELETE" });
    expect((await share("after revoke")).status).toBe(401);
    expect((await alice.ok("/me/tokens")).length).toBe(0);
  });

  test("a viewer can't make a token for a vault", async () => {
    expect((await bob.req("/me/tokens", { body: { vaultId: cv } })).status).toBe(403);
  });
});

describe("MCP server", () => {
  const { Client: McpClient } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let av: number;
  let rw = "";
  let ro = "";
  const connect = async (token: string) => {
    const c = new McpClient({ name: "e2e", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  const call = async (c: any, name: string, args: object) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: r.isError as boolean, text: r.content[0].text as string, data: r.structuredContent };
  };

  test("an MCP token is made in Account; the official client connects and lists the tools", async () => {
    av = (await alice.ok("/vaults", { body: { name: "Agent" } })).id;
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Home/Boiler.md", content: "# Boiler\n\nService due in March. See [[Plumber]].\n" } });
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Plumber.md", content: "# Plumber\n\nCall Sam. #trades\n" } });
    const made = await alice.ok("/me/tokens", { body: { kind: "mcp", name: "Claude Code" } });
    rw = made.token;
    expect(rw).toMatch(/^cpm_/);
    expect(made.row).toMatchObject({ scope: "mcp", vault_id: null });
    ro = (await alice.ok("/me/tokens", { body: { kind: "mcp", name: "Reader", readOnly: true } })).token;
    const c = await connect(rw);
    expect(c.getServerVersion()).toMatchObject({ name: "commonplace" });
    const names = (await c.listTools()).tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["append_to_note", "create_note", "create_type", "edit_note", "list_notes", "list_tags", "list_types", "list_vaults", "merge_notes", "move_note", "read_note", "rewrite_note", "search_notes", "set_properties", "set_type", "split_note"]);
    await c.close();
  });

  test("search, read, list: across your vaults, by vault name", async () => {
    const c = await connect(rw);
    const vs = (await call(c, "list_vaults", {})).data.vaults;
    expect(vs.some((v: any) => v.name === "Agent" && v.role === "owner")).toBe(true);
    const unspecified = await call(c, "search_notes", { query: "boiler" });
    expect(unspecified.error).toBe(true); // Alice has several vaults: it asks which
    expect(unspecified.text).toContain("say which");
    const found = await call(c, "search_notes", { query: "boiler service", vault: "agent" });
    expect(found.error).toBe(false);
    expect(found.data.results[0]).toMatchObject({ title: "Boiler", path: "Home/Boiler.md" });
    expect(found.data.results[0].snippet).not.toContain("<mark>");
    const note = await call(c, "read_note", { note: "Boiler", vault: av });
    expect(note.data).toMatchObject({ path: "Home/Boiler.md", links: ["Plumber.md"] });
    expect(note.data.content).toContain("Service due in March");
    expect((await call(c, "read_note", { note: "[[Plumber]]", vault: av })).data.backlinks).toEqual(["Home/Boiler.md"]);
    expect((await call(c, "list_notes", { vault: av, folder: "Home" })).data.notes.map((n: any) => n.path)).toEqual(["Home/Boiler.md"]);
    expect((await call(c, "list_tags", { vault: av })).data.tags).toEqual([{ tag: "trades", count: 1 }]);
    const missing = await call(c, "read_note", { note: "Nope", vault: av });
    expect(missing.error).toBe(true);
    await c.close();
  });

  test("create, append (merging with live typing) and edit, each kept in history", async () => {
    const c = await connect(rw);
    expect((await call(c, "create_note", { vault: av, path: "Home/Summary", content: "# Summary\n" })).data).toMatchObject({ created: "Home/Summary.md" });
    const id = (await alice.ok(`/vaults/${av}/notes`)).find((n: any) => n.path === "Home/Summary.md").id;
    const live = alice.live(id);
    await live.synced;
    live.text.insert(live.text.length, "Typed by Alice.\n");
    await reachedServer(alice, id, "Typed by Alice.");
    expect((await call(c, "append_to_note", { vault: av, note: "Summary", text: "- Boiler service due in March" })).error).toBe(false);
    await until(() => live.text.toString().includes("- Boiler service due in March"));
    expect(live.text.toString()).toContain("Typed by Alice.");
    live.provider.destroy();
    const ambiguous = await call(c, "edit_note", { vault: av, note: "Home/Boiler.md", find: "e", replace: "x" });
    expect(ambiguous.error).toBe(true);
    expect(ambiguous.text).toContain("more than once");
    expect((await call(c, "edit_note", { vault: av, note: "Home/Boiler.md", find: "due in March", replace: "booked for 4 March" })).error).toBe(false);
    const boiler = (await alice.ok(`/vaults/${av}/notes`)).find((n: any) => n.path === "Home/Boiler.md");
    expect((await alice.ok(`/vaults/${av}/notes/${boiler.id}`)).content).toContain("booked for 4 March");
    const revs = await alice.ok(`/vaults/${av}/notes/${boiler.id}/revisions`);
    expect(revs.some((r: any) => r.reason === "mcp")).toBe(true); // the text before the edit
    // A burst of agent edits keeps the version before the first, not a copy per call.
    const kept = revs.filter((r: any) => r.reason === "mcp").length;
    for (const day of ["5", "6", "7"]) expect((await call(c, "edit_note", { vault: av, note: "Home/Boiler.md", find: /booked for \d/.exec((await alice.ok(`/vaults/${av}/notes/${boiler.id}`)).content)![0], replace: `booked for ${day}` })).error).toBe(false);
    expect((await alice.ok(`/vaults/${av}/notes/${boiler.id}/revisions`)).filter((r: any) => r.reason === "mcp")).toHaveLength(kept);
    // An agent appending in a loop stops at 5 MB a note.
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Log.md", content: "x".repeat(4_999_000) } });
    const chunk = { vault: av, note: "Log", text: "y".repeat(199_000) };
    expect((await call(c, "append_to_note", chunk)).error).toBe(false);
    const over = await call(c, "append_to_note", chunk);
    expect(over.error).toBe(true);
    expect(over.text).toContain("at most 5 MB");
    expect((await call(c, "append_to_note", { vault: av, note: "Ideas/New", text: "first", create: true })).data).toMatchObject({ created: "Ideas/New.md" });
    await c.close();
  });

  test("a read-only token sees only read tools; a viewer can't write; tokens are refused without auth or once revoked", async () => {
    const r = await connect(ro);
    expect((await r.listTools()).tools.map((t: any) => t.name)).not.toContain("create_note");
    expect((await call(r, "create_note", { vault: av, path: "X" })).error).toBe(true);
    await r.close();
    await addMember(av, bob, "viewer");
    const bobTok = (await bob.ok("/me/tokens", { body: { kind: "mcp", name: "Bob" } })).token;
    const b = await connect(bobTok);
    const denied = await call(b, "append_to_note", { vault: "Agent", note: "Plumber", text: "x" });
    expect(denied.error).toBe(true);
    expect(denied.text).toContain("read-only for you");
    expect((await call(b, "read_note", { vault: "Agent", note: "Plumber" })).error).toBe(false);
    await b.close();

    const post = (headers: Record<string, string>, url = `${BASE}/mcp`) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await post({})).status).toBe(401);
    expect((await post({}, `${BASE}/mcp?token=${rw}`)).status).toBe(401); // never from the URL
    expect((await post({ authorization: `Bearer ${rw}`, origin: "https://evil.example" })).status).toBe(403);
    const captureTok = (await alice.ok("/me/tokens", { body: { kind: "capture", vaultId: av } })).token;
    expect((await post({ authorization: `Bearer ${captureTok}` })).status).toBe(401); // a capture token isn't an MCP token
    const mine = (await alice.ok("/me/tokens")).filter((t: any) => t.scope.startsWith("mcp"));
    for (const t of mine) await alice.ok(`/me/tokens/${t.id}`, { method: "DELETE" });
    expect((await post({ authorization: `Bearer ${rw}` })).status).toBe(401);
  });
});

describe("types (F16)", () => {
  let tv: number;
  const make = async (path: string, content: string) => (await alice.ok(`/vaults/${tv}/notes`, { body: { path, content } })).id as number;

  test("a type is a note in Types/; notes say `type:` in any common form; undefined types are listed too", async () => {
    tv = (await alice.ok("/vaults", { body: { name: "Typed" } })).id;
    await make("Types/Person.md", "---\nicon: user\ncolour: blue\nproperties:\n  - name: role\n    kind: select\n    options: [Friend, Trade]\n  - name: company\n    kind: relation\n    type: Organisation\n  - name: bogus\n    kind: wat\n---\n# {{title}}\n\n## Notes\n");
    await make("Types/Meeting.md", "---\nicon: calendar\nproperties:\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n");
    await make("Types/Deep/NotAType.md", "---\nicon: x\n---\n");
    await make("People/Sam.md", "---\ntype: Person\nrole: Trade\ncompany: \"[[Acme]]\"\n---\n# Sam\n");
    await make("People/Alex.md", '---\ntype: "[[Person]]"\n---\n# Alex\n');
    await make("People/Kim.md", "---\ntype: [person]\n---\n");
    await make("Reading/Dune.md", "---\ntype: Book\n---\n");
    const r = await alice.ok(`/vaults/${tv}/types`);
    expect(r.types.map((t: any) => [t.name, t.count])).toEqual([["Meeting", 0], ["Person", 3]]);
    const person = r.types.find((t: any) => t.name === "Person");
    expect(person).toMatchObject({ icon: "user", colour: "blue", path: "Types/Person.md" });
    expect(person.properties).toEqual([
      { name: "role", kind: "select", options: ["Friend", "Trade"] },
      { name: "company", kind: "relation", type: "Organisation", many: false },
      { name: "bogus", kind: "text" },
    ]);
    expect(r.undefined).toEqual([{ name: "Book", count: 1 }]);
    expect((await alice.ok(`/vaults/${tv}/notes`)).find((n: any) => n.path === "People/Alex.md").type).toBe("Person");
  });

  test("a type's page lists its notes with properties and orphans; saved views are a .base file that exports", async () => {
    const page = await alice.ok(`/vaults/${tv}/types/Person`);
    expect(page.notes.map((n: any) => n.title)).toEqual(["Alex", "Kim", "Sam"]);
    expect(page.notes.find((n: any) => n.title === "Sam").frontmatter).toMatchObject({ role: "Trade", company: "[[Acme]]" });
    expect(page.views).toBeNull();
    const yaml = 'filters:\n  and:\n    - type == "Person"\nviews:\n  - type: table\n    name: By role\n    order: [file.name, role]\n    groupBy:\n      property: role\n      direction: ASC\n';
    await alice.ok(`/vaults/${tv}/types/Person/views`, { method: "PUT", body: { yaml } });
    expect((await alice.ok(`/vaults/${tv}/types/Person`)).views).toBe(yaml);
    const zip = unzipSync((await alice.req(`/vaults/${tv}/export`)).data);
    expect(strFromU8(zip["Types/Person.base"]!)).toBe(yaml);
  });

  test("setting properties merges into live typing and leaves the rest of the note alone", async () => {
    const id = (await alice.ok(`/vaults/${tv}/notes`)).find((n: any) => n.title === "Kim").id;
    const live = alice.live(id);
    await live.synced;
    live.text.insert(live.text.length, "Typed while the table changed.\n");
    await reachedServer(alice, id, "Typed while the table changed.");
    await alice.ok(`/vaults/${tv}/notes/${id}/properties`, { method: "PATCH", body: { set: { role: "Friend", company: "[[Acme]]" } } });
    await until(() => live.text.toString().includes("role: Friend"));
    expect(live.text.toString()).toContain("Typed while the table changed.");
    expect(live.text.toString()).toStartWith("---\ntype: [person]\nrole: Friend\ncompany: \"[[Acme]]\"\n---\n");
    live.provider.destroy();
    expect((await bob.req(`/vaults/${tv}/notes/${id}/properties`, { method: "PATCH", body: { set: { role: "x" } } })).status).toBe(404);
  });

  test("relations show from the other side: backlinks say which property they come through", async () => {
    await make("Meetings/Kickoff.md", "---\ntype: Meeting\nattendees:\n  - \"[[Sam]]\"\n  - \"[[Alex]]\"\n---\n# Kickoff\n");
    await make("Meetings/Review.md", "---\ntype: Meeting\nattendees: [\"[[People/Sam]]\"]\n---\nSam talked about [[Sam]].\n");
    await make("Diary.md", "Saw [[Sam]] today.\n");
    const sam = (await alice.ok(`/vaults/${tv}/notes`)).find((n: any) => n.title === "Sam").id;
    const { backlinks } = await alice.ok(`/vaults/${tv}/notes/${sam}/links`);
    const by = Object.fromEntries(backlinks.map((b: any) => [b.title, [b.type, b.properties]]));
    expect(by).toEqual({ Kickoff: ["Meeting", ["attendees"]], Review: ["Meeting", ["attendees"]], Diary: [null, []] });
  });

  test("the type editor saves the definition and keeps the template; bad properties are refused", async () => {
    const shape = {
      icon: "users",
      colour: "green",
      properties: [
        { name: "role", kind: "select", options: ["Friend", "Trade", "Family"] },
        { name: "company", kind: "relation", type: "Organisation" },
        { name: "email", kind: "text" },
      ],
    };
    await alice.ok(`/vaults/${tv}/types/Person`, { method: "PUT", body: shape });
    const person = (await alice.ok(`/vaults/${tv}/types`)).types.find((t: any) => t.name === "Person");
    expect(person).toMatchObject({ icon: "users", colour: "green" });
    expect(person.properties.map((p: any) => p.name)).toEqual(["role", "company", "email"]);
    const note = await alice.ok(`/vaults/${tv}/notes/${person.noteId}`);
    expect(note.content).toContain("    options: [Friend, Trade, Family]");
    expect(note.content).toEndWith("---\n# {{title}}\n\n## Notes\n");
    for (const bad of [[{ name: "type", kind: "text" }], [{ name: "a", kind: "text" }, { name: "A", kind: "number" }], [{ name: " ", kind: "text" }]]) {
      expect((await alice.req(`/vaults/${tv}/types/Person`, { method: "PUT", body: { ...shape, properties: bad } })).status).toBe(400);
    }
    expect((await alice.req(`/vaults/${tv}/types/Nope`, { method: "PUT", body: shape })).status).toBe(404);
  });

  test("renaming a type renames it everywhere: notes, other types' relations, saved views", async () => {
    const r = await alice.ok(`/vaults/${tv}/types/Person/rename`, { body: { to: "Contact" } });
    expect(r.changed).toBe(3);
    const { types } = await alice.ok(`/vaults/${tv}/types`);
    expect(types.map((t: any) => t.name)).toEqual(["Contact", "Meeting"]);
    expect(types.find((t: any) => t.name === "Meeting").properties[0].type).toBe("Contact");
    expect((await alice.ok(`/vaults/${tv}/types/Contact`)).notes.map((n: any) => n.title)).toEqual(["Alex", "Kim", "Sam"]);
    expect((await alice.ok(`/vaults/${tv}/types/Contact`)).views).toContain('type == "Contact"');
    expect((await alice.req(`/vaults/${tv}/types/Contact/rename`, { body: { to: "Meeting" } })).status).toBe(409);
    await alice.ok(`/vaults/${tv}/types/Contact/rename`, { body: { to: "Person" } });
  });

  test("a day lists what was made and changed on it", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const d = await alice.ok(`/vaults/${tv}/days/${today}`);
    expect(d.made.map((n: any) => n.title)).toContain("Kickoff");
    expect(d.made.find((n: any) => n.title === "Kickoff").type).toBe("Meeting");
    expect((await alice.ok(`/vaults/${tv}/days/2001-01-01`)).made).toEqual([]);
    expect((await alice.req(`/vaults/${tv}/days/yesterday`)).status).toBe(400);
  });
});

describe("small wins: tasks, mentions, bookmarks", () => {
  let sv: number;
  const make = async (path: string, content: string) => (await alice.ok(`/vaults/${sv}/notes`, { body: { path, content } })).id as number;
  const text = async (id: number) => (await alice.ok(`/vaults/${sv}/notes/${id}`)).content as string;

  test("every task in the vault, with due dates, not in code or frontmatter; ticking one merges with typing", async () => {
    sv = (await alice.ok("/vaults", { body: { name: "Small wins" } })).id;
    const a = await make("Kitchen.md", "---\ntodo: - [ ] not a task\n---\n# Kitchen\n- [ ] Choose tiles 📅 2026-10-20\n- [x] Get quotes\n\n```\n- [ ] in code\n```\n");
    await make("Garden.md", "# Garden\n  * [ ] Mow\n1. [X] Plant bulbs\n");
    const tasks = await alice.ok(`/vaults/${sv}/tasks`);
    expect(tasks.map((t: any) => [t.title, t.text, t.done, t.due])).toEqual([
      ["Garden", "Mow", false, null],
      ["Garden", "Plant bulbs", true, null],
      ["Kitchen", "Choose tiles 📅 2026-10-20", false, "2026-10-20"],
      ["Kitchen", "Get quotes", true, null],
    ]);
    const tiles = tasks.find((t: any) => t.text.startsWith("Choose"));
    const live = alice.live(a);
    await live.synced;
    live.text.insert(0, "Typed first. ");
    await reachedServer(alice, a, "Typed first. ");
    await alice.ok(`/vaults/${sv}/notes/${a}/tasks`, { method: "PATCH", body: { line: tiles.line, text: tiles.text, done: true } });
    await until(() => live.text.toString().includes("- [x] Choose tiles"));
    expect(live.text.toString()).toStartWith("Typed first. ");
    live.provider.destroy();
    expect((await alice.req(`/vaults/${sv}/notes/${a}/tasks`, { method: "PATCH", body: { line: 0, text: "Not there", done: true } })).status).toBe(409);
  });

  test("unlinked mentions, outside links and code, and one click links the words that were there", async () => {
    const boiler = await make("Boiler.md", "# Boiler\n");
    const diary = await make("Diary.md", "Called about the boiler today, then the Boiler engineer came.\n");
    await make("Linked.md", "See [[Boiler]] and the boiler.\n");
    await make("Code.md", "`boiler` only in code\n");
    await make("Boilerplate.md", "Some boilerplate text.\n");
    const m = await alice.ok(`/vaults/${sv}/notes/${boiler}/mentions`);
    expect(m.map((x: any) => x.title)).toEqual(["Diary"]);
    expect(m[0].snippet).toContain("Called about the boiler today");
    await alice.ok(`/vaults/${sv}/notes/${boiler}/mentions`, { body: { source: diary } });
    expect(await text(diary)).toBe("Called about the [[Boiler|boiler]] today, then the Boiler engineer came.\n");
    expect(await alice.ok(`/vaults/${sv}/notes/${boiler}/mentions`)).toEqual([]);
  });

  test("bookmarks are per person; note summaries carry created_at for sorting", async () => {
    const id = (await alice.ok(`/vaults/${sv}/notes`)).find((n: any) => n.title === "Garden").id;
    expect(await alice.ok(`/vaults/${sv}/bookmarks/${id}`, { method: "PUT" })).toEqual([id]);
    expect(await alice.ok(`/vaults/${sv}/bookmarks`)).toEqual([id]);
    expect((await bob.req(`/vaults/${sv}/bookmarks`)).status).toBe(404); // not a member
    expect(await alice.ok(`/vaults/${sv}/bookmarks/${id}`, { method: "DELETE" })).toEqual([]);
    expect((await alice.ok(`/vaults/${sv}/notes`))[0].created_at).toBeTruthy();
  });
});

describe("weblinks", () => {
  let wv: number;
  let page: ReturnType<typeof Bun.serve>;
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  beforeAll(() => {
    page = Bun.serve({
      port: 3188,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/cover.png") return new Response(png, { headers: { "content-type": "image/png" } });
        if (u.pathname === "/old") return Response.redirect(`http://localhost:3188/article`, 301);
        return new Response(
          `<!doctype html><html><head><title>Fallback title</title>
          <meta property="og:title" content="Tiling a Kitchen &amp; Bathroom">
          <meta name="description" content="A plain guide to tiling, from &#8216;setting out&#8217; to grout.">
          <meta property="og:site_name" content="The Tiling Guide">
          <meta property="og:image" content="/cover.png">
          </head><body>…</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
  });
  afterAll(() => page?.stop(true));

  test("a link becomes a Weblink note with the page's title, summary, site and picture; saving it again finds the same note", async () => {
    wv = (await alice.ok("/vaults", { body: { name: "Links" } })).id;
    const w = await alice.ok(`/vaults/${wv}/weblinks`, { body: { url: "http://localhost:3188/old" } });
    expect(w).toMatchObject({ title: "Tiling a Kitchen & Bathroom", existed: false });
    const n = await alice.ok(`/vaults/${wv}/notes/${w.id}`);
    expect(n.path).toBe("Weblinks/Tiling a Kitchen & Bathroom.md");
    expect(n.frontmatter).toMatchObject({ type: "Weblink", url: "http://localhost:3188/article", site: "The Tiling Guide", description: "A plain guide to tiling, from ‘setting out’ to grout." });
    expect(n.content).toMatch(/!\[\[attachments\/weblinks\/Tiling a Kitchen & Bathroom\.png\]\]/);
    expect(n.content).toContain("> A plain guide to tiling");
    expect((await alice.ok(`/vaults/${wv}/types`)).types.map((t: any) => t.name)).toContain("Weblink");
    const again = await alice.ok(`/vaults/${wv}/weblinks`, { body: { url: "http://localhost:3188/article" } });
    expect(again).toMatchObject({ id: w.id, existed: true });
    expect((await alice.req(`/vaults/${wv}/weblinks`, { body: { url: "ftp://example.com/x" } })).status).toBe(400);
    expect((await bob.req(`/vaults/${wv}/weblinks`, { body: { url: "http://localhost:3188/article" } })).status).toBe(404);
  });
});

describe("bring your own AI", () => {
  const fakeAi = startFakeAi(3197);
  const { script, seen } = fakeAi;
  afterAll(() => fakeAi.stop());

  const FAKE = "http://localhost:3197";
  const KEY = "fake-key-for-tests-a1b2";
  let av: number;
  let claude: number;
  let summary: number;
  async function chat(c: Client, body: object) {
    const res = await fetch(`${BASE}/api/ai/chat`, { method: "POST", headers: { cookie: c.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { status: res.status, events: [] as any[], end: null as any, error: (await res.json()).error as string };
    const events = (await res.text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));
    return { status: res.status, events, end: events.find((e) => e.type === "end"), error: events.find((e) => e.type === "error")?.message as string | undefined };
  }
  const content = async (id: number) => (await alice.ok(`/vaults/${av}/notes/${id}`)).content as string;

  test("adding an assistant: the key is sealed, never returned, and only its owner can use it", async () => {
    av = (await alice.ok("/vaults", { body: { name: "AI" } })).id;
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Home/Boiler.md", content: "# Boiler\n\nService due in March.\n" } });
    summary = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "Summary.md", content: "# Summary\n" } })).id;
    expect((await alice.req("/me/assistants", { body: { name: "my claude", provider: "anthropic", apiKey: "k" } })).status).toBe(400);
    expect((await alice.req("/me/assistants", { body: { name: "Claude", provider: "anthropic", baseUrl: "http://example.com", apiKey: "k" } })).status).toBe(400);
    const a = await alice.ok("/me/assistants", { body: { name: "Claude", provider: "anthropic", baseUrl: FAKE, apiKey: KEY } });
    claude = a.id;
    expect(a).toMatchObject({ name: "Claude", provider: "anthropic", model: "claude-opus-5-5", key_hint: "a1b2" });
    const listed = JSON.stringify(await alice.ok("/me/assistants"));
    expect(listed).not.toContain(KEY);
    expect(listed).not.toContain("key_enc");
    const [row] = await testDb`select key_enc from user_assistants where id = ${claude}`;
    expect(row!.key_enc).toStartWith("v1.");
    expect(row!.key_enc).not.toContain("fake-key");
    expect((await alice.req("/me/assistants", { body: { name: "CLAUDE", provider: "anthropic", baseUrl: FAKE, apiKey: "x" } })).status).toBe(409);
    expect((await bob.ok("/me/assistants")).length).toBe(0);
    expect((await bob.req(`/me/assistants/${claude}`, { method: "DELETE" })).status).toBe(404);
    expect((await chat(bob, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "hi" }] })).status).toBe(404);
  });

  test("Test sends one tiny request with the key in a header, never the URL", async () => {
    seen.length = 0;
    expect(await alice.ok("/me/assistants/test", { body: { id: claude } })).toMatchObject({ ok: true, reply: "ready" });
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]!.path).toBe("/v1/messages");
    const bad = await alice.req("/me/assistants/test", { body: { draft: { name: "X", provider: "anthropic", baseUrl: FAKE, apiKey: "bad" } } });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain("refused the API key");
  });

  test("it searches and writes into the open note at once; the text before is kept as an ai version", async () => {
    script.push(
      { text: "Let me look.", calls: [{ name: "search_notes", input: { query: "boiler" } }] },
      { calls: [{ name: "append_to_note", input: { note: "Summary", text: "- Boiler: service due in March ([[Boiler]])" } }] },
      { text: "Added a line to Summary." },
    );
    seen.length = 0;
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: [{ role: "user", text: "Summarise the boiler here" }] });
    expect(r.error).toBeUndefined();
    expect(r.events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("Let me look.Added a line to Summary.");
    expect(r.events.filter((e) => e.type === "tool").map((e) => [e.name, e.ok])).toEqual([["search_notes", true], ["append_to_note", true]]);
    expect(r.end.pending).toEqual([]);
    expect(r.end.usage).toEqual({ input: 300, output: 60, cacheRead: 0, cacheWrite: 0 });
    // Opus 5.5 at $4/$20 a million is £3/£15: 300 in and 60 out cost £0.0018.
    expect(r.end.cost).toBeCloseTo(0.0018, 6);
    expect(r.end.cap).toBe(1);
    expect(r.end.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(await content(summary)).toContain("- Boiler: service due in March ([[Boiler]])");
    const revs = await alice.ok(`/vaults/${av}/notes/${summary}/revisions`);
    expect(revs[0].reason).toBe("ai");
    // The open note is in the prompt, and the tool results go back as Anthropic tool_result blocks.
    expect(seen[0]!.body.system[0].text).toContain("The open note is “Summary”");
    expect(seen[0]!.body.tools.map((t: any) => t.name)).toContain("rewrite_note");
    expect(seen[1]!.body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: r.end.messages[1].calls[0].id });
  });

  test("anything beyond the open note waits for approval, with a preview; declining changes nothing", async () => {
    script.push({
      text: "I'll make a page.",
      calls: [
        { name: "create_note", input: { path: "Home/Boiler log", content: "# Boiler log\n\n- March: service\n" } },
        { name: "rewrite_note", input: { note: "Summary", content: "# Summary\n\n| Item | When |\n| --- | --- |\n| Boiler | March |\n" } },
      ],
    });
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: [{ role: "user", text: "Make a log page and turn this into a table" }] });
    expect(r.end.pending.map((p: any) => [p.name, p.kind])).toEqual([["create_note", "approve"], ["rewrite_note", "approve"]]);
    expect(r.end.pending[0].preview).toMatchObject({ noteId: null, path: "Home/Boiler log.md", before: null });
    expect(r.end.pending[1].preview.before).toContain("- Boiler: service due in March");
    expect(r.end.pending[1].preview.after).toContain("| Boiler | March |");
    expect((await alice.ok(`/vaults/${av}/notes`)).some((x: any) => x.path === "Home/Boiler log.md")).toBe(false);
    const before = await content(summary);

    script.push({ text: "Made the log; left Summary as it was." });
    const [create, rewrite] = r.end.pending;
    const r2 = await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: r.end.messages, resolved: [{ id: create.id, approve: true }, { id: rewrite.id, approve: false }] });
    expect(r2.error).toBeUndefined();
    expect(r2.events.find((e) => e.type === "tool")).toMatchObject({ name: "create_note", ok: true });
    expect((await alice.ok(`/vaults/${av}/notes`)).some((x: any) => x.path === "Home/Boiler log.md")).toBe(true);
    expect(await content(summary)).toBe(before);
    const results = r2.end.messages.find((m: any) => m.role === "tool" && m.results.some((x: any) => x.id === rewrite.id)).results;
    expect(results.find((x: any) => x.id === rewrite.id)).toMatchObject({ isError: true });
  });

  test("once it has read another vault, even a change to the open note asks first", async () => {
    // Text in a shared note could tell the model to copy a private vault's note into it.
    script.push(
      { calls: [{ name: "read_note", input: { vault, note: "Alpha" } }] },
      { calls: [{ name: "append_to_note", input: { note: "Summary", text: "copied from elsewhere" } }] },
    );
    const before = await content(summary);
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: [{ role: "user", text: "Tidy this note" }] });
    expect(r.error).toBeUndefined();
    expect(r.end.pending.map((p: any) => [p.name, p.kind])).toEqual([["append_to_note", "approve"]]);
    expect(await content(summary)).toBe(before);
  });

  test("organising: properties on the open note apply live; moving another note asks first and updates links", async () => {
    script.push({ calls: [{ name: "set_properties", input: { note: "Summary", properties: { status: "done", tags: ["home"] } } }, { name: "move_note", input: { note: "Boiler", to: "Archive/Boiler" } }] });
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: [{ role: "user", text: "Mark this done and archive the boiler note" }] });
    expect(await content(summary)).toStartWith("---\nstatus: done\ntags:\n  - home\n---\n# Summary");
    expect(r.end.pending.map((p: any) => p.name)).toEqual(["move_note"]);
    expect(r.end.pending[0].preview.summary).toBe("Move “Boiler” to Archive/Boiler.md, updating links in 1 note");
    script.push({ text: "Done." });
    await chat(alice, { assistantId: claude, vaultId: av, noteId: summary, messages: r.end.messages, resolved: [{ id: r.end.pending[0].id, approve: true }] });
    expect((await alice.ok(`/vaults/${av}/notes`)).some((x: any) => x.path === "Archive/Boiler.md")).toBe(true);
  });

  test("split_note moves a section into a new note and leaves an embed", async () => {
    const long = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "Kitchen.md", content: "# Kitchen\n\nIntro.\n\n## Budget\n\n£7,500 total.\n\n## Tasks\n\n- [ ] Tiles\n" } })).id;
    script.push({ calls: [{ name: "split_note", input: { note: "Kitchen", section: "Budget", to: "Kitchen budget" } }] });
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: long, messages: [{ role: "user", text: "Split out the budget" }] });
    expect(r.end.pending[0].preview.after).toBe("# Kitchen\n\nIntro.\n\n## Budget\n\n![[Kitchen budget]]\n\n## Tasks\n\n- [ ] Tiles\n");
    script.push({ text: "Split." });
    await chat(alice, { assistantId: claude, vaultId: av, noteId: long, messages: r.end.messages, resolved: [{ id: r.end.pending[0].id, approve: true }] });
    expect(await content(long)).toBe("# Kitchen\n\nIntro.\n\n## Budget\n\n![[Kitchen budget]]\n\n## Tasks\n\n- [ ] Tiles\n");
    const made = (await alice.ok(`/vaults/${av}/notes`)).find((x: any) => x.path === "Kitchen budget.md");
    expect(await content(made.id)).toBe("£7,500 total.\n");
  });

  test("the browser's own tools (driving the app) come back for the browser to run", async () => {
    const clientTools = [{ name: "open_note", description: "Open a note in the app", input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }];
    script.push({ calls: [{ name: "open_note", input: { note: "Kitchen" } }] });
    const r = await chat(alice, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "Open the kitchen note" }], clientTools });
    expect(r.end.pending).toMatchObject([{ name: "open_note", kind: "client", input: { note: "Kitchen" } }]);
    script.push({ text: "It's open." });
    const r2 = await chat(alice, { assistantId: claude, vaultId: av, messages: r.end.messages, clientTools, resolved: [{ id: r.end.pending[0].id, result: { content: "Opened Kitchen" } }] });
    expect(r2.end.messages.at(-1)).toMatchObject({ role: "assistant", text: "It's open." });
  });

  test("a viewer's assistant gets only the read tools; OpenAI-compatible providers work too", async () => {
    await addMember(av, bob, "viewer");
    const bobs = await bob.ok("/me/assistants", { body: { name: "Router", provider: "compatible", baseUrl: `${FAKE}/v1`, model: "some/model", apiKey: "fake-bob-key" } });
    seen.length = 0;
    script.push({ calls: [{ name: "read_note", input: { note: "Kitchen" } }] }, { text: "It's about tiles." });
    const r = await chat(bob, { assistantId: bobs.id, vaultId: av, messages: [{ role: "user", text: "What's in Kitchen?" }] });
    expect(r.error).toBeUndefined();
    expect(r.end.messages.at(-1).text).toBe("It's about tiles.");
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe("Bearer fake-bob-key");
    const names = seen[0]!.body.tools.map((t: any) => t.function.name);
    expect(names).toContain("read_note");
    expect(names).not.toContain("create_note");
    expect(seen[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: r.end.messages[1].calls[0].id });
  });

  test("relaxAI is OpenAI-format with room for its reasoning, and defaults to DeepSeek-V4-Pro", async () => {
    const relax = await alice.ok("/me/assistants", { body: { name: "Relax", provider: "relaxai", baseUrl: `${FAKE}/v1`, apiKey: "fake-relax-key" } });
    expect(relax).toMatchObject({ provider: "relaxai", model: "DeepSeek-V4-Pro" });
    seen.length = 0;
    script.push({ text: "Hello from the UK." });
    const r = await chat(alice, { assistantId: relax.id, vaultId: av, messages: [{ role: "user", text: "hi" }] });
    expect(r.end.messages.at(-1).text).toBe("Hello from the UK.");
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.body).toMatchObject({ model: "DeepSeek-V4-Pro", max_tokens: 32000, stream: true });
    expect(seen[0]!.headers.authorization).toBe("Bearer fake-relax-key");
  });

  test("a daily £ limit: checked before every call, a turn stops cleanly at it, and tomorrow is another day", async () => {
    const pricey = await alice.ok("/me/assistants", { body: { name: "Pricey", provider: "anthropic", baseUrl: FAKE, apiKey: "fake-key", price: { in: 1000, out: 1000 }, dailyCap: 0.05 } });
    expect(pricey).toMatchObject({ price: { in: 1000, out: 1000 }, custom_price: true, daily_cap: 0.05, spent_today: 0 });
    // One call (100 in, 20 out at £1000 a million) costs £0.12, over the limit: the turn's next step doesn't happen.
    script.push({ calls: [{ name: "search_notes", input: { query: "x" } }] }, { text: "never sent" });
    const before = seen.length;
    const r = await chat(alice, { assistantId: pricey.id, vaultId: av, messages: [{ role: "user", text: "look" }] });
    expect(seen.length - before).toBe(1);
    expect(r.end).toMatchObject({ stopped: "cap", cap: 0.05 });
    expect(r.end.cost).toBeCloseTo(0.12, 6);
    expect(r.end.notice).toContain("has used its £0.05 for today");
    expect(r.end.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]); // the search it asked for still ran
    script.length = 0;
    const again = await chat(alice, { assistantId: pricey.id, vaultId: av, messages: [...r.end.messages, { role: "user", text: "and now?" }] });
    expect(again.end.stopped).toBe("cap");
    expect(seen.length - before).toBe(1); // nothing more sent to the provider
    expect((await alice.ok("/me/assistants")).find((a: any) => a.id === pricey.id).spent_today).toBeCloseTo(0.12, 6);
    expect((await alice.req("/me/assistants/test", { body: { id: pricey.id } })).status).toBe(429);
    // Raising the limit lets it carry on; tomorrow (a new ledger day) would too.
    await alice.ok(`/me/assistants/${pricey.id}`, { method: "PATCH", body: { dailyCap: 10 } });
    script.push({ text: "Back." });
    expect((await chat(alice, { assistantId: pricey.id, vaultId: av, messages: [{ role: "user", text: "hi" }] })).end.stopped).toBeUndefined();
    await testDb`update ai_usage set day = day - 1 where assistant_id = ${pricey.id}`;
    expect((await alice.ok("/me/assistants")).find((a: any) => a.id === pricey.id).spent_today).toBe(0);
  });

  test("a limit needs a price: an unknown model must be given one; list prices fill in otherwise", async () => {
    const unknown = { name: "Mystery", provider: "compatible", baseUrl: `${FAKE}/v1`, model: "who/knows", apiKey: "k" };
    const refused = await alice.req("/me/assistants", { body: { ...unknown, dailyCap: 1 } });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain("needs the model's price");
    expect(await alice.ok("/me/assistants", { body: { ...unknown, dailyCap: null } })).toMatchObject({ price: null, daily_cap: null });
    const listed = await alice.ok("/me/assistants", { body: { name: "Nemo", provider: "relaxai", baseUrl: `${FAKE}/v1`, model: "Nemotron-3-Super", apiKey: "k" } });
    expect(listed).toMatchObject({ price: { in: 0.22, out: 0.67 }, custom_price: false, daily_cap: 1 });
  });

  test("the organiser knows the types: it types the open note at once, asks before typing others, and keeps to choices", async () => {
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Types/Person.md", content: "---\nicon: user\nproperties:\n  - name: role\n    kind: select\n    options: [Friend, Trade]\n  - name: organisation\n    kind: relation\n    type: Organisation\n---\n# {{title}}\n" } });
    const sam = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "Inbox/Sam.md", content: "# Sam\n\nPlumber from Acme.\n" } })).id;
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Inbox/Jo.md", content: "# Jo\n\nOld school friend.\n" } });
    seen.length = 0;
    script.push(
      { calls: [{ name: "set_type", input: { note: "Sam", type: "Person", properties: { role: "Trade", organisation: "[[Acme]]" } } }, { name: "set_type", input: { note: "Jo", type: "Person", properties: { role: "Friend" } } }, { name: "set_type", input: { note: "Jo", type: "Person", properties: { role: "Neighbour" } } }] },
    );
    const r = await chat(alice, { assistantId: claude, vaultId: av, noteId: sam, messages: [{ role: "user", text: "File these into types" }] });
    expect(seen[0]!.body.system[0].text).toContain("- Person, 0 notes: role (one of Friend/Trade), organisation (link to Organisation)");
    expect(await content(sam)).toStartWith('---\ntype: Person\nrole: Trade\norganisation: "[[Acme]]"\n---\n# Sam');
    const tools = r.events.filter((e) => e.type === "tool");
    expect(tools.map((e) => [e.name, e.ok])).toEqual([["set_type", true], ["set_type", false]]);
    expect(tools[1].summary).toContain("role is one of: Friend, Trade");
    expect(r.end.pending.map((p: any) => [p.name, p.preview.summary])).toEqual([["set_type", "Make “Jo” a Person (role)"]]);
  });

  test("create_type proposes a type with a preview; applied, it's a real type", async () => {
    script.push({ calls: [{ name: "create_type", input: { name: "Recipe", icon: "book", colour: "green", properties: [{ name: "serves", kind: "number" }, { name: "course", kind: "select", options: ["Main", "Pudding"] }], template: "# {{title}}\n\n## Ingredients\n\n## Method\n" } }] });
    const r = await chat(alice, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "Make a recipe type" }] });
    expect(r.end.pending[0].preview).toMatchObject({ summary: "Create the Recipe type (serves, course)", path: "Types/Recipe.md", before: null });
    expect(r.end.pending[0].preview.after).toContain("    options: [Main, Pudding]");
    script.push({ text: "Made it." });
    await chat(alice, { assistantId: claude, vaultId: av, messages: r.end.messages, resolved: [{ id: r.end.pending[0].id, approve: true }] });
    const recipe = (await alice.ok(`/vaults/${av}/types`)).types.find((t: any) => t.name === "Recipe");
    expect(recipe).toMatchObject({ icon: "book", colour: "green" });
    expect(recipe.properties.map((p: any) => p.name)).toEqual(["serves", "course"]);
  });

  test("merge_notes folds a duplicate in, relinks every note, and sends the duplicate to Trash", async () => {
    const keep = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "People/Priya.md", content: "---\ntype: Person\nrole: Friend\n---\n# Priya\n\nMet at uni.\n" } })).id;
    const dup = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "Inbox/Priya Shah.md", content: "---\ntype: Person\nphone: 07700 900456\n---\n# Priya Shah\n\nDesigner at Shah Interiors.\n" } })).id;
    const linker = (await alice.ok(`/vaults/${av}/notes`, { body: { path: "Diary.md", content: "Lunch with [[Priya Shah]].\n" } })).id;
    script.push({ calls: [{ name: "merge_notes", input: { keep: "Priya", merge: "Priya Shah" } }] });
    const r = await chat(alice, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "These are the same person" }] });
    expect(r.end.pending[0].preview.summary).toBe("Merge “Priya Shah” into “Priya”, 1 note relinked; “Priya Shah” goes to Trash");
    script.push({ text: "Merged." });
    await chat(alice, { assistantId: claude, vaultId: av, messages: r.end.messages, resolved: [{ id: r.end.pending[0].id, approve: true }] });
    const kept = await content(keep);
    expect(kept).toContain("phone: 07700 900456");
    expect(kept).toContain("role: Friend");
    expect(kept).toContain("## From Priya Shah\n\nDesigner at Shah Interiors.");
    expect(await content(linker)).toBe("Lunch with [[Priya]].\n");
    expect((await alice.req(`/vaults/${av}/notes/${dup}`)).status).toBe(404);
    expect((await alice.ok(`/vaults/${av}/trash`)).items.some((t: any) => t.path === "Inbox/Priya Shah.md")).toBe(true);
    // Different types won't merge.
    await alice.ok(`/vaults/${av}/notes`, { body: { path: "Acme.md", content: "# Acme\n" } });
    script.push({ calls: [{ name: "merge_notes", input: { keep: "Priya", merge: "Acme" } }] }, { text: "Can't." });
    const bad = await chat(alice, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "merge" }] });
    expect(bad.events.find((e) => e.type === "tool")).toMatchObject({ name: "merge_notes", ok: false });
  });

  test("a provider error comes back as a plain message", async () => {
    await alice.ok(`/me/assistants/${claude}`, { method: "PATCH", body: { apiKey: "bad" } });
    const r = await chat(alice, { assistantId: claude, vaultId: av, messages: [{ role: "user", text: "hi" }] });
    expect(r.error).toContain("refused the API key");
    expect((await alice.ok("/me/assistants")).find((a: any) => a.id === claude).key_hint).toBe("bad");
  });
});

describe("GitHub vaults (F14)", () => {
  const gh = startFakeGitHub(3187);
  afterAll(() => gh.stop());
  let v: number;
  const list = async () => (await alice.ok(`/vaults/${v}/notes`)) as { id: number; path: string }[];
  const idOf = async (path: string) => (await list()).find((n) => n.path === path)!.id;
  const write = async (path: string, content: string) => alice.ok(`/vaults/${v}/notes/${await idOf(path)}/content`, { method: "PUT", body: { content } });
  const read = async (path: string) => (await alice.ok(`/vaults/${v}/notes/${await idOf(path)}`)).content as string;
  const status = () => alice.ok(`/vaults/${v}/git`);

  test("a token is checked with GitHub, kept sealed and never sent back", async () => {
    expect((await alice.req("/me/github")).data).toEqual({ available: true, connection: null });
    expect((await alice.req("/me/github", { method: "PUT", body: { token: "github_pat_not_the_right_one_000" } })).data.error).toContain("refused the token");
    expect((await alice.req("/me/github/repos")).status).toBe(409); // not connected yet
    expect(await alice.ok("/me/github", { method: "PUT", body: { token: TOKEN } })).toEqual({ login: "sam", token_hint: TOKEN.slice(-4) });
    const [row] = await testDb`select token_sealed from user_github`;
    expect(row!.token_sealed).not.toContain(TOKEN);
    expect(JSON.stringify(await alice.ok("/me/github"))).not.toContain(TOKEN);
  });

  test("pick a repo, branch and folder: only notes and attachments come in", async () => {
    expect((await alice.ok("/me/github/repos"))[0]).toMatchObject({ full_name: "sam/house", default_branch: "main" });
    expect(await alice.ok("/me/github/repos/sam/house/branches")).toEqual(["main"]);
    const folders = await alice.ok("/me/github/repos/sam/house/folders?branch=main");
    expect(folders.slice(0, 2)).toEqual([{ folder: "", notes: 4 }, { folder: "docs", notes: 3 }]);
    const r = await alice.ok("/vaults/github", { body: { repo: "sam/house", branch: "main", folder: "docs" } });
    v = r.vault.id;
    expect(r).toMatchObject({ notes: 3, files: 1, vault: { name: "house / docs" } });
    expect((await list()).map((n) => n.path).sort()).toEqual(["Boiler.md", "Garden.md", "Rooms/Kitchen.md"]);
    expect((await alice.ok("/vaults")).find((x: any) => x.id === v).git_repo).toBe("sam/house");
    expect(await status()).toMatchObject({ repo: "sam/house", folder: "docs", baseBranch: "main", pushed: false, changes: [], unpushed: 0 });
    // Bob isn't a member: nothing about it shows.
    expect((await bob.req(`/vaults/${v}/git`)).status).toBe(404);
  });

  test("edits, a new note, a move and a deletion show as changes, with a diff; one reverts", async () => {
    await write("Boiler.md", "# Boiler\n\nServiced in May by Sam.\n\n- filter\n- pressure\n");
    await write("Garden.md", "# Garden\n\nPlant bulbs in October.\n");
    await alice.ok(`/vaults/${v}/notes`, { body: { path: "Ideas.md", content: "# Ideas\n" } });
    await alice.ok(`/vaults/${v}/notes/${await idOf("Rooms/Kitchen.md")}`, { method: "PATCH", body: { path: "Kitchen.md", updateLinks: false } });
    let st = await status();
    expect(st.changes.map((c: any) => [c.path, c.kind, c.from]).sort()).toEqual([
      ["Boiler.md", "edited", undefined],
      ["Garden.md", "edited", undefined],
      ["Ideas.md", "added", undefined],
      ["Kitchen.md", "moved", "Rooms/Kitchen.md"],
    ]);
    expect(st.branch).toMatch(/^commonplace\//);
    const d = await alice.ok(`/vaults/${v}/git/diff?path=Garden.md`);
    expect(d).toMatchObject({ before: "# Garden\n\nPlant bulbs.\n", after: "# Garden\n\nPlant bulbs in October.\n" });
    st = await alice.ok(`/vaults/${v}/git/revert`, { body: { path: "Garden.md" } });
    expect(await read("Garden.md")).toBe("# Garden\n\nPlant bulbs.\n");
    expect(st.changes).toHaveLength(3);
    // A viewer can look but not change anything.
    await addMember(v, bob, "viewer");
    expect((await bob.req(`/vaults/${v}/git`)).status).toBe(200);
    expect((await bob.req(`/vaults/${v}/git/push`, { body: { message: "x" } })).status).toBe(403);
  });

  test("Open pull request: one commit on a branch, built on the base tree, so code and dot-folders are untouched", async () => {
    const pushBody = { message: "Boiler and kitchen notes", title: "Boiler and kitchen notes", body: "From Commonplace", branch: "commonplace/boiler" };
    // GitHub refuses the pull request after the branch is pushed: the vault knows its branch,
    // says so, and the next try opens the PR rather than pushing the branch again.
    gh.refuseNextPull(422, "Validation Failed");
    const refused = await alice.req(`/vaults/${v}/git/push`, { body: pushBody });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain("on branch commonplace/boiler, but the pull request didn't open");
    expect(await alice.ok(`/vaults/${v}/git`)).toMatchObject({ pushed: true, pr: null, unpushed: 0 });
    expect(gh.refs.has("commonplace/boiler")).toBe(true);
    const st = await alice.ok(`/vaults/${v}/git/push`, { body: pushBody });
    expect(st).toMatchObject({ pushed: true, branch: "commonplace/boiler", pr: { number: 1, state: "open" }, unpushed: 0 });
    const files = gh.files("commonplace/boiler");
    expect(files["docs/Boiler.md"]).toContain("by Sam");
    expect(files["docs/Ideas.md"]).toBe("# Ideas\n");
    expect(files["docs/Kitchen.md"]).toBe("# Kitchen\n\nQuartz worktops.\n");
    expect(files["docs/Rooms/Kitchen.md"]).toBeUndefined();
    expect(files["docs/Garden.md"]).toBe("# Garden\n\nPlant bulbs.\n");
    expect(files["src/index.ts"]).toBe("console.log('hi')\n");
    expect(files["docs/.obsidian/app.json"]).toBe("{}");
    expect(gh.pulls[0]).toMatchObject({ head: "commonplace/boiler", base: "main", title: "Boiler and kitchen notes" });
    expect(gh.files("main")["docs/Boiler.md"]).not.toContain("by Sam"); // nothing reaches main without the PR
  });

  test("later edits are further commits on the same PR", async () => {
    await write("Ideas.md", "# Ideas\n\n- solar\n");
    expect((await status()).unpushed).toBe(1);
    const st = await alice.ok(`/vaults/${v}/git/push`, { body: { message: "More ideas" } });
    expect(st).toMatchObject({ unpushed: 0, pr: { number: 1 } });
    expect(gh.files("commonplace/boiler")["docs/Ideas.md"]).toContain("solar");
    expect(gh.pulls).toHaveLength(1);
    expect((await alice.req(`/vaults/${v}/git/push`, { body: { message: "again" } })).data.error).toContain("on GitHub already");
  });

  test("Update from main: someone else's edits merge line by line; a real clash waits for a choice", async () => {
    gh.commitToMain({ "docs/Boiler.md": "# Boiler\n\nServiced in May.\n\n- filter\n- pressure\n- flue\n", "docs/Garden.md": "# Garden\n\nPlant bulbs and tulips.\n", "docs/Shed.md": "# Shed\n" });
    await write("Ideas.md", "# Ideas\n\n- solar\n- heat pump\n");
    const r = await alice.ok(`/vaults/${v}/git/update`, { body: {} });
    expect(r).toMatchObject({ upToDate: false, merged: 1, updated: 1, added: 1, clashes: 0 });
    expect(await read("Boiler.md")).toBe("# Boiler\n\nServiced in May by Sam.\n\n- filter\n- pressure\n- flue\n");
    expect(await read("Garden.md")).toBe("# Garden\n\nPlant bulbs and tulips.\n");
    expect(await read("Shed.md")).toBe("# Shed\n");
    // A clash: both sides change the same line.
    gh.commitToMain({ "docs/Ideas.md": "# Ideas\n\n- wind\n" });
    const c = await alice.ok(`/vaults/${v}/git/update`, { body: {} });
    expect(c.clashes).toBe(1);
    expect(await read("Ideas.md")).toBe("# Ideas\n\n- solar\n- heat pump\n"); // never <<<<<<< markers
    expect((await status()).clashes).toEqual([{ path: "Ideas.md", deletedThere: false }]);
    expect((await alice.req(`/vaults/${v}/git/push`, { body: { message: "x" } })).data.error).toContain("Settle the clash");
    expect((await alice.ok(`/vaults/${v}/git/diff?path=Ideas.md`)).theirs).toBe("# Ideas\n\n- wind\n");
    await alice.ok(`/vaults/${v}/git/resolve`, { body: { path: "Ideas.md", take: "mine" } });
    // The next push merges main into the branch: a merge commit, so the PR shows only our changes.
    const st = await alice.ok(`/vaults/${v}/git/push`, { body: { message: "Merge main, more ideas" } });
    expect(st.unpushed).toBe(0);
    expect(gh.parentsOf("commonplace/boiler")).toHaveLength(2);
    expect(gh.files("commonplace/boiler")["docs/Shed.md"]).toBe("# Shed\n");
  });

  test("after the PR is merged, Update from main ends the branch with nothing lost", async () => {
    gh.mergePr(1);
    const r = await alice.ok(`/vaults/${v}/git/update`, { body: {} });
    expect(r.clashes).toBe(0);
    const st = await status();
    expect(st).toMatchObject({ pushed: false, pr: null, changes: [], unpushed: 0 });
    expect(await read("Ideas.md")).toBe("# Ideas\n\n- solar\n- heat pump\n");
  });

  test("Cancel the branch: every change goes back, its edits stay in history, the branch is deleted", async () => {
    await write("Boiler.md", "# Boiler\n\nGone wrong.\n");
    await alice.ok(`/vaults/${v}/notes`, { body: { path: "Scratch.md", content: "x" } });
    await alice.ok(`/vaults/${v}/git/push`, { body: { message: "Scratch", branch: "commonplace/scratch" } });
    expect(gh.refs.has("commonplace/scratch")).toBe(true);
    const before = await read("Boiler.md");
    const r = await alice.ok(`/vaults/${v}/git/cancel`, { body: {} });
    expect(r).toEqual({ reverted: 2, prKept: null });
    expect(await read("Boiler.md")).not.toBe(before);
    expect((await list()).some((n) => n.path === "Scratch.md")).toBe(false);
    expect(gh.refs.has("commonplace/scratch")).toBe(false);
    const hist = await alice.ok(`/vaults/${v}/notes/${await idOf("Boiler.md")}/revisions`);
    expect(JSON.stringify(hist)).toContain("github-revert");
    expect((await status()).changes).toEqual([]);
  });

  test("the token only ever travels in the Authorization header", () => {
    expect(gh.seen.length).toBeGreaterThan(20);
    expect(gh.seen.every((r) => !/github_pat_/.test(r.url) && r.auth?.startsWith("Bearer github_pat_"))).toBe(true);
  });
});

// N9: the database disk is fixed, so near it the server refuses new data rather than letting
// Render suspend the database. A second server with a tiny disk sees this database as full.
describe("storage guard", () => {
  const FULL_PORT = 3198;
  const FULL = `http://localhost:${FULL_PORT}`;
  let full: ReturnType<typeof Bun.spawn>;
  let pruned = 0;
  afterAll(() => full?.kill());

  test("a server whose disk is nearly full refuses new data but keeps live typing, and prunes old versions at boot", async () => {
    // 105 versions of one note; the boot tidy keeps the newest 100.
    await testDb`insert into note_revisions (note_id, content, reason, created_at)
                 select ${ids.alpha}, 'v' || g, 'edit', now() - make_interval(days => g) from generate_series(1, 105) g`;
    full = Bun.spawn(["bun", "src/server.ts"], {
      env: { ...process.env, DATABASE_URL: DB, PORT: String(FULL_PORT), EMBEDDING_PROVIDER: "hash", DB_DISK_GB: "0.001", NODE_ENV: "production" },
      stdout: "ignore",
      stderr: "inherit",
    });
    await until(async () => (await fetch(`${FULL}/health`).catch(() => null))?.ok === true, 15000);
    await until(async () => {
      const [r] = await testDb`select count(*)::int as n from note_revisions where note_id = ${ids.alpha}`;
      const n = r!.n as number;
      pruned = n;
      return n <= 100;
    });
    expect(pruned).toBe(100);

    const a = new Client("alice@full", FULL);
    a.cookie = alice.cookie;
    expect((await a.ok("/session")).storage).toMatchObject({ state: "full" });
    const refused = await a.req(`/vaults/${vault}/notes`, { body: { path: "More.md", content: "more" } });
    expect(refused.status).toBe(507);
    expect(refused.data.error).toContain("Storage is nearly full");
    const form = new FormData();
    form.append("file", new File([new Uint8Array(100)], "pic.png", { type: "image/png" }));
    expect((await a.req(`/vaults/${vault}/files`, { form })).status).toBe(507);

    const live = a.live(ids.beta);
    await live.synced;
    live.text.insert(live.text.length, "\nStill typing.");
    await until(async () => (await a.ok(`/vaults/${vault}/notes/${ids.beta}`)).content.includes("Still typing."));
    live.provider.destroy();
  });
});

describe("invitations (N13)", () => {
  const { Client: McpClient } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const dave = new Client("dave");
  let iv: number;
  let noteId: number;
  const invite = (email: string, role = "editor") => alice.req(`/vaults/${iv}/members`, { method: "PUT", body: { email, role } });
  const pending = async (who: Client) => (await who.ok("/invitations")).find((i: any) => i.vault_id === iv);

  test("inviting says the same whether or not the email has an account", async () => {
    await dave.ok("/register", { body: { email: "dave@example.com", password: "password-d", name: "Dave" } });
    iv = (await alice.ok("/vaults", { body: { name: "Invites" } })).id;
    noteId = (await alice.ok(`/vaults/${iv}/notes`, { body: { path: "Secret.md", content: "# Secret\n\nThe plan." } })).id;
    const known = await invite("Dave@Example.com");
    const unknown = await invite("nobody-yet@example.com");
    expect(known).toEqual({ status: 200, data: { status: "invited" } });
    expect(unknown).toEqual(known);
    expect((await alice.ok(`/vaults/${iv}/invites`)).map((i: any) => i.email).sort()).toEqual(["dave@example.com", "nobody-yet@example.com"]);
    // Nobody but an owner manages or sees them.
    expect((await dave.req(`/vaults/${iv}/invites`)).status).toBe(404);
    expect((await bob.req(`/vaults/${iv}/members`, { method: "PUT", body: { email: "bob@example.com", role: "owner" } })).status).toBe(404);
  });

  test("a pending invitation grants no access anywhere", async () => {
    const i = await pending(dave);
    expect(i).toMatchObject({ vault_name: "Invites", role: "editor", invited_by: "Alice" });
    expect((await dave.ok("/vaults")).some((v: any) => v.id === iv)).toBe(false);
    for (const path of [`/vaults/${iv}/notes`, `/vaults/${iv}/notes/${noteId}`, `/vaults/${iv}/search?q=plan`, `/vaults/${iv}/members`, `/vaults/${iv}/events`, `/vaults/${iv}/export`]) {
      expect((await dave.req(path)).status).toBe(404);
    }
    expect((await dave.req(`/vaults/${iv}/notes`, { body: { path: "Mine.md", content: "x" } })).status).toBe(404);
    // No capture token for it, and no live socket.
    expect((await dave.req("/me/tokens", { body: { vaultId: iv, name: "Phone" } })).status).toBe(404);
    const ws = await fetch(`${BASE}/ws/${noteId}`, { headers: { cookie: dave.cookie, upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(ws.status).toBe(404);
    // And nothing over MCP (the AI tools run as the person, with their vault roles).
    const token = (await dave.ok("/me/tokens", { body: { kind: "mcp", name: "Dave's agent" } })).token;
    const c = new McpClient({ name: "e2e", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const listed = await c.callTool({ name: "list_vaults", arguments: {} });
    expect(listed.structuredContent.vaults.some((v: any) => v.id === iv || v.name === "Invites")).toBe(false);
    const read = await c.callTool({ name: "read_note", arguments: { vault: "Invites", note: "Secret" } });
    expect(read.isError).toBe(true);
    await c.close();
    // Someone else can't accept it for them.
    expect((await bob.req(`/invitations/${i.id}/accept`, { method: "POST" })).status).toBe(404);
    expect((await bob.req(`/invitations/${i.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("Accept joins with the invited role; the invitation is used up", async () => {
    const i = await pending(dave);
    const v = await dave.ok(`/invitations/${i.id}/accept`, { method: "POST" });
    expect(v).toMatchObject({ id: iv, name: "Invites", role: "editor", member_count: 2 });
    expect((await dave.ok(`/vaults/${iv}/notes/${noteId}`)).content).toContain("The plan.");
    expect(await pending(dave)).toBeUndefined();
    expect((await dave.req(`/invitations/${i.id}/accept`, { method: "POST" })).status).toBe(404);
    expect((await alice.ok(`/vaults/${iv}/invites`)).map((x: any) => x.email)).toEqual(["nobody-yet@example.com"]);
    // Inviting a member again changes their role, straight away.
    expect((await invite("dave@example.com", "viewer")).data).toEqual({ status: "updated" });
    expect((await dave.ok(`/vaults/${iv}/notes/${noteId}`)).role).toBe("viewer");
  });

  test("an invitation waits for someone who signs up later", async () => {
    const late = new Client("nobody-yet");
    await late.ok("/register", { body: { email: "nobody-yet@example.com", password: "password-n" } });
    expect((await late.ok("/vaults")).some((v: any) => v.id === iv)).toBe(false);
    const i = await pending(late);
    expect(i.role).toBe("editor");
    // Decline drops it, and grants nothing.
    await late.ok(`/invitations/${i.id}`, { method: "DELETE" });
    expect(await pending(late)).toBeUndefined();
    expect((await late.req(`/vaults/${iv}/notes`)).status).toBe(404);
    expect(await alice.ok(`/vaults/${iv}/invites`)).toEqual([]);
  });

  test("an owner can cancel an invitation before it's answered", async () => {
    await invite("bob@example.com", "viewer");
    const i = await pending(bob);
    await alice.ok(`/vaults/${iv}/invites/${i.id}`, { method: "DELETE" });
    expect(await pending(bob)).toBeUndefined();
    expect((await bob.req(`/invitations/${i.id}/accept`, { method: "POST" })).status).toBe(404);
    expect((await bob.req(`/vaults/${iv}/notes`)).status).toBe(404);
  });

  test("Undo after removing a member puts them back; leaving needs a new invitation", async () => {
    const d = (await dave.ok("/session")).user;
    await alice.ok(`/vaults/${iv}/members/${d.id}`, { method: "DELETE" });
    expect((await dave.req(`/vaults/${iv}/notes`)).status).toBe(404);
    expect((await dave.req(`/vaults/${iv}/members/${d.id}/restore`, { method: "POST" })).status).toBe(404);
    await alice.ok(`/vaults/${iv}/members/${d.id}/restore`, { method: "POST" });
    expect((await dave.ok(`/vaults/${iv}/notes/${noteId}`)).role).toBe("viewer");
    expect((await alice.req(`/vaults/${iv}/members/${d.id}/restore`, { method: "POST" })).status).toBe(404); // once
    await dave.ok(`/vaults/${iv}/members/${d.id}`, { method: "DELETE" }); // leaves
    expect((await alice.req(`/vaults/${iv}/members/${d.id}/restore`, { method: "POST" })).status).toBe(404);
    expect((await dave.req(`/vaults/${iv}/notes`)).status).toBe(404);
  });
});

describe("security headers and Trash purge rules (N13)", () => {
  test("the app's page has a CSP, can't be framed, and keeps its address from other sites; HSTS only over https", async () => {
    const res = await fetch(`${BASE}/v/1/n/2`); // any app path is the page
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self'(;|$)/); // no inline script in production
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' data: blob: https:"); // remote images in notes still show
    expect(csp).toContain(`connect-src 'self' ws://localhost:${PORT}`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBeNull();

    const https = await fetch(`${BASE}/`, { headers: { "x-forwarded-proto": "https" } });
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(https.headers.get("content-security-policy")).toContain(`connect-src 'self' wss://localhost:${PORT}`);

    // The API, too: nothing to sniff or frame.
    const api = await fetch(`${BASE}/api/session`);
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    // The page's own scripts are still served.
    const html = await (await fetch(`${BASE}/`)).text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)![1]!;
    const js = await fetch(new URL(script, BASE));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  test("an attachment keeps its own sandboxing CSP", async () => {
    const v = (await alice.ok("/vaults", { body: { name: "Headers" } })).id;
    const form = new FormData();
    form.append("file", new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "x.svg", { type: "image/svg+xml" }));
    const up = await alice.ok(`/vaults/${v}/files`, { form });
    const res = await fetch(`${BASE}/api/vaults/${v}/files?path=${encodeURIComponent(up.path)}`, { headers: { cookie: alice.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("only the owner deletes from Trash for good, one note or all; editors can still restore", async () => {
    const v = (await alice.ok("/vaults", { body: { name: "Purge" } })).id;
    await addMember(v, bob, "editor");
    const a = await alice.ok(`/vaults/${v}/notes`, { body: { path: "A.md", content: "# A" } });
    const b = await alice.ok(`/vaults/${v}/notes`, { body: { path: "B.md", content: "# B" } });
    const { trashId: ta } = await bob.ok(`/vaults/${v}/notes/${a.id}`, { method: "DELETE" });
    const { trashId: tb } = await bob.ok(`/vaults/${v}/notes/${b.id}`, { method: "DELETE" });
    expect((await bob.req(`/vaults/${v}/trash/${ta}`, { method: "DELETE" })).status).toBe(403);
    expect((await bob.req(`/vaults/${v}/trash`, { method: "DELETE" })).status).toBe(403);
    expect((await bob.ok(`/vaults/${v}/trash`)).items).toHaveLength(2); // nothing was lost
    await bob.ok(`/vaults/${v}/trash/${ta}/restore`, { method: "POST" });
    expect((await alice.ok(`/vaults/${v}/trash/${tb}`, { method: "DELETE" })).deleted).toBe(1);
    expect((await alice.ok(`/vaults/${v}/trash`)).items).toHaveLength(0);
  });
});
