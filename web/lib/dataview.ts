// Dataview in the app: the renderer leaves a ```dataview block or an inline `= expression` as a
// placeholder holding its source; fillDataview() asks the vault for the results (the server, or
// the open folder in the standalone file) and shows them. Results are kept, so a redraw shows the
// last answer at once and swaps in the new one; refreshDataview() re-asks after notes change.
// Ticking a task in a TASK result ticks it in its own note.

import type { Result } from "../../src/dataview";
import { esc, renderResult } from "../../src/dataviewRender";
import { api, type NoteSummary } from "./api";
import { resolveLocal } from "./links";
import { renderMarkdown } from "./render";
import { toastError } from "../ui/overlays";

export interface DataviewCtx {
  vaultId: number;
  /** The note the query sits in, for `this`. */
  noteId: number | null;
  /** The vault's notes as they are now (they may still be loading when results first show). */
  notes: () => NoteSummary[];
  onOpen: (target: string) => void;
  /** Asked when a task is clicked (a note can turn read-only after its results are shown). */
  canTick?: () => boolean;
}

const offset = () => -new Date().getTimezoneOffset();
const results = new Map<string, Result>();
const live = new WeakMap<HTMLElement, DataviewCtx>();

type Job = { el: HTMLElement; kind: "query" | "inline"; source: string; key: string };
const queued = new Map<string, { ctx: DataviewCtx; jobs: Job[] }>();
let timer: ReturnType<typeof setTimeout> | null = null;

function keyOf(ctx: DataviewCtx, kind: string, source: string) {
  return `${ctx.vaultId}:${ctx.noteId}:${kind}:${source}`;
}

/** Fill every placeholder under `root` not filled yet. */
export function fillDataview(root: ParentNode, ctx: DataviewCtx): void {
  for (const el of root.querySelectorAll<HTMLElement>(".dataview-block:not([data-done]), .dataview-inline:not([data-done])")) {
    el.dataset.done = "1";
    const inline = el.classList.contains("dataview-inline");
    const source = inline ? (el.dataset.dvExpr ?? "") : (el.querySelector("code")?.textContent ?? "");
    el.dataset.dvSource = source;
    if (!live.has(el)) el.addEventListener("click", (e) => onClick(e, live.get(el)!));
    live.set(el, ctx);
    const key = keyOf(ctx, inline ? "inline" : "query", source);
    const had = results.get(key);
    if (had) show(el, had, ctx);
    enqueue(ctx, { el, kind: inline ? "inline" : "query", source, key }, had ? 400 : 0);
  }
}

/** Ask again for every result on screen (after notes changed). */
export function refreshDataview(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".dataview-block[data-done], .dataview-inline[data-done]")) {
    const ctx = live.get(el);
    if (!ctx) continue;
    const inline = el.classList.contains("dataview-inline");
    const source = el.dataset.dvSource ?? "";
    enqueue(ctx, { el, kind: inline ? "inline" : "query", source, key: keyOf(ctx, inline ? "inline" : "query", source) }, 400);
  }
}

function enqueue(ctx: DataviewCtx, job: Job, delay: number) {
  const k = `${ctx.vaultId}:${ctx.noteId}`;
  const q = queued.get(k) ?? { ctx, jobs: [] };
  q.ctx = ctx;
  q.jobs = q.jobs.filter((j) => j.el !== job.el);
  q.jobs.push(job);
  queued.set(k, q);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, delay);
}

async function flush() {
  timer = null;
  const batches = [...queued.values()];
  queued.clear();
  for (const { ctx, jobs } of batches) {
    // One request per note: its blocks and inline expressions together, each source once.
    const sources = [...new Map(jobs.map((j) => [`${j.kind}:${j.source}`, { kind: j.kind, source: j.source }])).values()];
    let out: Result[];
    try {
      out = await api<Result[]>(`/vaults/${ctx.vaultId}/dataview`, { method: "POST", body: { noteId: ctx.noteId, offset: offset(), items: sources } });
    } catch (e) {
      out = sources.map(() => ({ kind: "error", message: (e as Error).message || "couldn't run the query" }) as Result);
    }
    const byKey = new Map(sources.map((s, i) => [keyOf(ctx, s.kind, s.source), out[i]!]));
    for (const [k, r] of byKey) results.set(k, r);
    if (results.size > 500) for (const k of [...results.keys()].slice(0, 100)) results.delete(k);
    for (const j of jobs) if (j.el.isConnected) show(j.el, byKey.get(j.key)!, ctx);
  }
}

/** One line of Markdown, as the note renderer shows it (sanitised), without its paragraph. */
function inline(md: string, ctx: DataviewCtx) {
  return renderMarkdown(md, ctx.vaultId, ctx.notes()).trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}

function html(r: Result, ctx: DataviewCtx, inlineEl: boolean) {
  return renderResult(
    r,
    {
    canTick: true,
    inline: (md) => inline(md, ctx),
    link(path, display, _resolved, subpath) {
      const hit = resolveLocal(ctx.notes(), path);
      const target = path + (subpath ? `#${subpath}` : "");
      return `<a class="internal-link${hit ? "" : " unresolved"}" data-target="${esc(target)}" href="${hit ? `/v/${ctx.vaultId}/n/${hit.id}` : "#"}">${esc(display)}</a>`;
      },
    },
    inlineEl,
  );
}

function show(el: HTMLElement, r: Result, ctx: DataviewCtx) {
  const inlineEl = el.classList.contains("dataview-inline");
  const next = html(r, ctx, inlineEl);
  if (el.dataset.dvShown === next) return;
  el.dataset.dvShown = next;
  // Results are built from escaped text and sanitised Markdown (renderMarkdown).
  el.innerHTML = r.kind === "error" && !inlineEl ? `${next}<pre><code>${esc(el.dataset.dvSource ?? "")}</code></pre>` : next;
  el.classList.toggle("dv-failed", r.kind === "error");
  el.dispatchEvent(new Event("cp-dataview", { bubbles: true }));
}

/** Clicks inside results: links open their note, checkboxes tick their task. */
function onClick(e: Event, ctx: DataviewCtx): boolean {
  const t = e.target as HTMLElement;
  const box = t.closest<HTMLInputElement>("input.dv-task");
  if (box) {
    e.stopPropagation();
    void tick(box, ctx);
    return true;
  }
  const a = t.closest<HTMLAnchorElement>(".dataview-block a.internal-link, .dataview-inline a.internal-link");
  if (a && a.dataset.target) {
    e.preventDefault();
    e.stopPropagation();
    ctx.onOpen(a.dataset.target);
    return true;
  }
  return false;
}

async function tick(box: HTMLInputElement, ctx: DataviewCtx) {
  const path = box.dataset.path ?? "";
  const hit = resolveLocal(ctx.notes(), path.replace(/\.md$/i, ""));
  if (!hit || ctx.canTick?.() === false) {
    box.checked = !box.checked;
    return;
  }
  box.disabled = true;
  try {
    await api(`/vaults/${ctx.vaultId}/notes/${hit.id}/tasks`, { method: "PATCH", body: { line: Number(box.dataset.line), text: box.dataset.text ?? "", done: box.checked } });
  } catch (e) {
    box.checked = !box.checked;
    toastError(e);
  } finally {
    box.disabled = false;
    refreshDataview();
  }
}
