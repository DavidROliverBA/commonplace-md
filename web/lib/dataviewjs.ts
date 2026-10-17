// dataviewjs blocks in the app: each runs in its own sandboxed frame (src/sandbox.ts,
// web/sandbox/dvjs.ts) with an opaque origin and no network. The frame gets the vault's pages
// (what this reader can read anyway) and the block's code; it can draw only inside itself. It asks
// the app for a few things by message, each checked here: open a note, tick a task (as the reader,
// with their rights), read a note or file of this vault, open a web page, and how tall it is.
// Publish runs each block the same way, unseen, over the published notes only, and keeps what it
// drew (freezeDataviewJs). A frame that stops answering (a script stuck in a loop the sandbox's
// guard can't see) is closed.

import type { PageData } from "../../src/dataview";
import { api } from "./api";
import { type DataviewCtx, tickTask } from "./dataview";

interface Frame {
  iframe: HTMLIFrameElement;
  box: HTMLElement;
  code: string;
  ready: boolean;
  /** When the unanswered ping was sent (0: none waiting). */
  pingAt: number;
  /** A block in a note on screen… */
  ctx?: DataviewCtx;
  /** …or one run for Publish, which gives back what it drew. */
  cap?: { vaultId: number; path: string; pages: PageData[]; done: (html: string) => void };
}

const frames = new Map<Window, Frame>();
/** Frames whose window isn't known yet (not in the page when made): matched on first message. */
const pending = new Set<Frame>();
const MAX_HEIGHT = 20_000;

/** The sandbox page: the app serves it; the standalone file carries it, gzipped. */
let srcdoc: Promise<string> | null = null;
function sandboxDoc(): Promise<string> | null {
  const packed = document.getElementById("dvjs-sandbox")?.textContent?.trim();
  if (!packed) return null;
  srcdoc ??= new Response(new Blob([Uint8Array.from(atob(packed), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return srcdoc;
}

// The vault's pages, once per version of its note list.
const pagesCache = new WeakMap<object, Promise<PageData[]>>();
function pagesOf(ctx: DataviewCtx): Promise<PageData[]> {
  const notes = ctx.notes();
  let p = pagesCache.get(notes);
  if (!p) {
    p = api<PageData[]>(`/vaults/${ctx.vaultId}/dataview/pages`);
    p.catch(() => pagesCache.delete(notes));
    pagesCache.set(notes, p);
  }
  return p;
}

function sandboxFrame(box: HTMLElement): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.className = "dv-frame";
  iframe.title = "dataviewjs view";
  // Scripts only: no same origin, forms, pop-ups, downloads or top navigation.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  box.replaceChildren(iframe);
  const doc = sandboxDoc();
  if (doc) void doc.then((html) => (iframe.srcdoc = html));
  else iframe.src = "/sandbox/dataviewjs";
  return iframe;
}

/** Start a frame for every ```dataviewjs block under `root` not started yet. */
export function fillDataviewJs(root: ParentNode, ctx: DataviewCtx): void {
  for (const box of root.querySelectorAll<HTMLElement>(".dataviewjs-block:not([data-done])")) {
    box.dataset.done = "1";
    const code = box.querySelector("code")?.textContent ?? "";
    pending.add({ iframe: sandboxFrame(box), box, ctx, code, ready: false, pingAt: 0 });
    watch();
  }
}

const zone = () => ({ offset: -new Date().getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });

async function run(f: Frame) {
  if (!f.iframe.isConnected || !f.iframe.contentWindow) return;
  if (f.cap) {
    f.iframe.contentWindow.postMessage({ dvjs: 1, type: "run", code: f.code, pages: f.cap.pages, thisPath: f.cap.path, capture: true, ...zone() }, "*");
    return;
  }
  const ctx = f.ctx!;
  let pages: PageData[];
  try {
    pages = await pagesOf(ctx);
  } catch {
    pages = [];
  }
  const thisPath = ctx.noteId === null ? null : (ctx.notes().find((n) => n.id === ctx.noteId)?.path ?? null);
  f.iframe.contentWindow.postMessage({ dvjs: 1, type: "run", code: f.code, pages, thisPath, ...zone() }, "*");
}

// ── frames that stop answering ────────────────────────────────────────────────────────────

const PING_MS = 2000;
const GIVE_UP_MS = 10_000;
let watching: ReturnType<typeof setInterval> | null = null;

/** Every couple of seconds, ask each frame if it's there; one that hasn't answered in ten is
 *  stuck, so it's closed and says why. Measured from the ping, so a tab in the background (whose
 *  timers slow down) doesn't count as stuck. */
function watch() {
  watching ??= setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    for (const [w, f] of frames) {
      if (!f.iframe.isConnected) {
        frames.delete(w);
        continue;
      }
      if (f.pingAt && now - f.pingAt > GIVE_UP_MS) {
        frames.delete(w);
        stuck(f);
      } else if (!f.pingAt) {
        f.pingAt = now;
        w.postMessage({ dvjs: 1, type: "ping" }, "*");
      }
    }
    if (!frames.size && !pending.size && watching) {
      clearInterval(watching);
      watching = null;
    }
  }, PING_MS);
}

const STUCK = "Evaluation Error: this script stopped answering, so it was closed. Is there a loop that never ends?";

function stuck(f: Frame) {
  const msg = document.createElement("div");
  msg.className = "dv-error";
  msg.textContent = STUCK;
  // Taking the frame out of the page is what stops its script.
  f.box.replaceChildren(msg);
  f.box.dispatchEvent(new Event("cp-dataview", { bubbles: true }));
  f.cap?.done(`<div class="dv-error">${STUCK}</div>`);
}

// ── Publish ───────────────────────────────────────────────────────────────────────────────

const FREEZE_AT_ONCE = 4;
const FREEZE_MS = 20_000;

/** Run every dataviewjs block a Publish would show, unseen, and give back what each drew, for
 *  the published pages. Each sees the published notes only, and can read only published notes,
 *  the site's files and views' code (src/publish.ts). */
export async function freezeDataviewJs(vaultId: number, progress?: (done: number, of: number) => void): Promise<{ path: string; code: string; html: string }[]> {
  const { blocks, pages } = await api<{ blocks: { path: string; code: string }[]; pages: PageData[] }>(`/vaults/${vaultId}/site/dataviewjs`);
  if (!blocks.length) return [];
  // Off screen but laid out, at a page's width, so a script that measures sees sensible sizes.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  Object.assign(holder.style, { position: "fixed", left: "-10000px", top: "0", width: "760px", visibility: "hidden", pointerEvents: "none" });
  document.body.append(holder);
  const out: { path: string; code: string; html: string }[] = [];
  let next = 0;
  const one = async (): Promise<void> => {
    while (next < blocks.length) {
      const b = blocks[next++]!;
      const box = document.createElement("div");
      holder.append(box);
      const html = await new Promise<string>((done) => {
        const timer = setTimeout(() => done(`<div class="dv-error">Evaluation Error: this script didn't finish within ${FREEZE_MS / 1000} seconds.</div>`), FREEZE_MS);
        pending.add({ iframe: sandboxFrame(box), box, code: b.code, ready: false, pingAt: 0, cap: { vaultId, path: b.path, pages, done: (h) => (clearTimeout(timer), done(h)) } });
        watch();
      });
      box.remove();
      out.push({ ...b, html });
      progress?.(out.length, blocks.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(FREEZE_AT_ONCE, blocks.length) }, one));
  } finally {
    holder.remove();
  }
  return out;
}

/** Run every frame on screen again (the vault changed). */
export function rerunDataviewJs(): void {
  for (const [w, f] of frames) {
    if (!f.iframe.isConnected) frames.delete(w);
    else if (f.ready) void run(f);
  }
}

async function readFile(f: Frame, path: string): Promise<string> {
  const where = f.cap ? `/vaults/${f.cap.vaultId}/site/dataviewjs/file` : `/vaults/${f.ctx!.vaultId}/dataview/file`;
  return (await api<{ text: string }>(`${where}?path=${encodeURIComponent(path)}`)).text;
}

function frameFor(source: MessageEventSource | null): Frame | undefined {
  if (!source) return undefined;
  let f = frames.get(source as Window);
  if (f) return f;
  for (const p of pending) {
    if (!p.iframe.isConnected) pending.delete(p);
    else if (p.iframe.contentWindow === source) {
      pending.delete(p);
      frames.set(source as Window, p);
      return p;
    }
  }
  return undefined;
}

window.addEventListener("message", async (e) => {
  const f = frameFor(e.source);
  const m = e.data;
  if (!f || !m || m.dvjs !== 1 || typeof m.type !== "string") return;
  f.pingAt = 0;
  switch (m.type) {
    case "done":
      if (f.cap && typeof m.html === "string") f.cap.done(m.html);
      break;
    case "ready":
      f.ready = true;
      void run(f);
      break;
    case "height":
      if (f.cap) break;
      if (typeof m.h === "number" && m.h >= 0) f.iframe.style.height = `${Math.min(Math.ceil(m.h), MAX_HEIGHT)}px`;
      f.box.dispatchEvent(new Event("cp-dataview", { bubbles: true }));
      break;
    // A frame run for Publish can't be seen, so it opens and ticks nothing.
    case "open":
      if (f.ctx && typeof m.target === "string" && m.target.length < 1024) f.ctx.onOpen(m.target);
      break;
    case "external":
      if (f.ctx && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) window.open(m.url, "_blank", "noopener,noreferrer");
      break;
    case "tick":
      if (f.ctx && typeof m.path === "string" && typeof m.text === "string") await tickTask(f.ctx, m.path, Number(m.line), m.text, !!m.done);
      break;
    case "load": {
      const reply = (r: { ok: boolean; text?: string; error?: string }) => (e.source as Window).postMessage({ dvjs: 1, type: "loaded", id: m.id, ...r }, "*");
      if (typeof m.path !== "string" || m.path.length > 1024) return reply({ ok: false, error: "Which file?" });
      try {
        reply({ ok: true, text: await readFile(f, m.path) });
      } catch (err) {
        reply({ ok: false, error: (err as Error).message });
      }
      break;
    }
  }
});
