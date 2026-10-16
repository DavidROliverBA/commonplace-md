// dataviewjs blocks in the app: each runs in its own sandboxed frame (src/sandbox.ts,
// web/sandbox/dvjs.ts) with an opaque origin and no network. The frame gets the vault's pages
// (what this reader can read anyway) and the block's code; it can draw only inside itself. It asks
// the app for a few things by message, each checked here: open a note, tick a task (as the reader,
// with their rights), read a note or file of this vault, open a web page, and how tall it is.

import type { PageData } from "../../src/dataview";
import { api } from "./api";
import { type DataviewCtx, tickTask } from "./dataview";

interface Frame {
  iframe: HTMLIFrameElement;
  box: HTMLElement;
  ctx: DataviewCtx;
  code: string;
  ready: boolean;
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

/** Start a frame for every ```dataviewjs block under `root` not started yet. */
export function fillDataviewJs(root: ParentNode, ctx: DataviewCtx): void {
  for (const box of root.querySelectorAll<HTMLElement>(".dataviewjs-block:not([data-done])")) {
    box.dataset.done = "1";
    const code = box.querySelector("code")?.textContent ?? "";
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
    pending.add({ iframe, box, ctx, code, ready: false });
  }
}

async function run(f: Frame) {
  if (!f.iframe.isConnected || !f.iframe.contentWindow) return;
  let pages: PageData[];
  try {
    pages = await pagesOf(f.ctx);
  } catch {
    pages = [];
  }
  const thisPath = f.ctx.noteId === null ? null : (f.ctx.notes().find((n) => n.id === f.ctx.noteId)?.path ?? null);
  f.iframe.contentWindow.postMessage({ dvjs: 1, type: "run", code: f.code, pages, thisPath, offset: -new Date().getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, "*");
}

/** Run every frame on screen again (the vault changed). */
export function rerunDataviewJs(): void {
  for (const [w, f] of frames) {
    if (!f.iframe.isConnected) frames.delete(w);
    else if (f.ready) void run(f);
  }
}

async function readFile(f: Frame, path: string): Promise<string> {
  return (await api<{ text: string }>(`/vaults/${f.ctx.vaultId}/dataview/file?path=${encodeURIComponent(path)}`)).text;
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
  switch (m.type) {
    case "ready":
      f.ready = true;
      void run(f);
      break;
    case "height":
      if (typeof m.h === "number" && m.h >= 0) f.iframe.style.height = `${Math.min(Math.ceil(m.h), MAX_HEIGHT)}px`;
      f.box.dispatchEvent(new Event("cp-dataview", { bubbles: true }));
      break;
    case "open":
      if (typeof m.target === "string" && m.target.length < 1024) f.ctx.onOpen(m.target);
      break;
    case "external":
      if (typeof m.url === "string" && /^https?:\/\//i.test(m.url)) window.open(m.url, "_blank", "noopener,noreferrer");
      break;
    case "tick":
      if (typeof m.path === "string" && typeof m.text === "string") await tickTask(f.ctx, m.path, Number(m.line), m.text, !!m.done);
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
