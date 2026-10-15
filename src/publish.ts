// Publish a vault as a website (F18 step 1). An owner chooses what's published (the whole vault
// or folders; a note with `publish: false` stays out) in publish.json at the vault's top level, so
// the choice travels with an export or a GitHub repo. Publish takes a snapshot: each chosen note
// rendered to HTML and every file those pages show, copied into site_pages and site_files. The
// site at /p/<slug>/ is served from the snapshot alone, never from notes or attachments, so a note
// that isn't published, its title and its files can't be reached by any URL, and edits stay private
// until the next Publish.
//
// Pages carry no script at all, and the CSP says so: a note's raw HTML is cut down to a few
// formatting tags without attributes, and the page is sandboxed, so nothing on it runs as the app.
// Links between pages are relative, so the same snapshot can later be served at a custom domain.

import { randomBytes } from "node:crypto";
import { Marked, type Tokens } from "marked";
import { z } from "zod";
import { resolveLocal } from "../web/lib/links";
import { hiloColour } from "../web/lib/colours";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { findWikiLinks, isAttachmentPath, maskCode, normalisePath, parseFrontmatter, plainInline, sectionRange, SITE_SETTINGS } from "./markdown";
import { listNotes } from "./notes";
import { assertRoom } from "./storage";

// ── settings (publish.json) ────────────────────────────────────────────────────────────────

const Settings = z.looseObject({
  /** Folders to publish; empty: the whole vault. */
  include: z.array(z.string().max(512)).max(1000).default([]),
  /** The site's name; the vault's name when unset. */
  title: z.string().max(200).optional(),
});
export type SiteSettings = z.infer<typeof Settings>;

export async function readSettings(vaultId: number): Promise<{ settings: SiteSettings; error?: string }> {
  const [f] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${SITE_SETTINGS}`;
  if (!f) return { settings: { include: [] } };
  try {
    return { settings: Settings.parse(JSON.parse(new TextDecoder().decode(f.data))) };
  } catch {
    // Never fall back to "everything": a broken file must not publish more than was chosen.
    return { settings: { include: [] }, error: `${SITE_SETTINGS} isn't valid, so nothing can be published until it's fixed or what's published is chosen again.` };
  }
}

/** Set the published folders in publish.json, keeping any other keys in it. */
export async function saveSettings(vaultId: number, userId: number, include: string[]): Promise<SiteSettings> {
  const { settings, error } = await readSettings(vaultId);
  const folders = [...new Set(include.map((f) => normalisePath(f, null)))].sort();
  const next: SiteSettings = { ...(error ? { include: [] } : settings), include: folders };
  const data = new TextEncoder().encode(JSON.stringify(next, null, 2) + "\n");
  await assertRoom(data.byteLength);
  await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
            values (${vaultId}, ${SITE_SETTINGS}, 'application/json', ${data.byteLength}, ${data}, ${userId})
            on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size, mime = excluded.mime`;
  return next;
}

// ── what's published ──────────────────────────────────────────────────────────────────────

interface Chosen {
  id: number;
  path: string;
  title: string;
  content: string;
  md5: string;
}

/** The notes the settings choose, and those kept out by `publish: false`. */
async function choose(vaultId: number, s: SiteSettings): Promise<{ pages: Chosen[]; held: string[] }> {
  const rows = await sql<(Chosen & { held: boolean })[]>`
    select id, path, title, content, md5(content) as md5,
           coalesce(frontmatter->'publish' = 'false'::jsonb or lower(frontmatter->>'publish') in ('false', 'no'), false) as held
    from notes where vault_id = ${vaultId} order by lower(path)`;
  const inFolders = (p: string) => !s.include.length || s.include.some((f) => p.startsWith(f + "/"));
  const chosen = rows.filter((r) => inFolders(r.path));
  return { pages: chosen.filter((r) => !r.held), held: chosen.filter((r) => r.held).map((r) => r.path) };
}

/** "Projects/Plan.md" → "Projects/Plan": the page's address under the site. */
const pagePath = (notePath: string) => notePath.replace(/\.md$/i, "");

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A file a note refers to, resolved as the app does: relative to the note, the exact path, then
 *  the shortest path ending with it (links go by file name). */
function resolveFile(files: string[], notePath: string, target: string): string | undefined {
  const t = safeDecode(target.split("#")[0]!.split("?")[0]!).trim().replace(/^\.?\//, "");
  if (!t) return undefined;
  const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const seg of `${dir}/${t}`.split("/")) seg === ".." ? parts.pop() : seg && seg !== "." && parts.push(seg);
  const relative = parts.join("/").toLowerCase();
  const want = t.toLowerCase();
  let best: string | undefined;
  for (const f of files) {
    const l = f.toLowerCase();
    if (l === relative || l === want) return f;
    if (l.endsWith("/" + want) && (!best || f.length < best.length)) best = f;
  }
  return best;
}

/** Hidden text: %%comments%% (an unclosed one hides the rest) and ^block-ids. */
function stripHidden(md: string): string {
  const masked = maskCode(md);
  const cuts: [number, number][] = [];
  for (const m of masked.matchAll(/%%[\s\S]*?(?:%%|$(?![\s\S]))/g)) cuts.push([m.index!, m.index! + m[0].length]);
  for (const m of masked.matchAll(/[ \t]\^[\w-]+[ \t]*$/gm)) cuts.push([m.index!, m.index! + m[0].length]);
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) continue; // inside a comment already cut
    out += md.slice(at, from);
    at = to;
  }
  return out + md.slice(at);
}

const MD_LINK = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Every vault file a note's visible text shows or links to. */
function fileRefs(files: string[], notePath: string, md: string): string[] {
  const body = stripHidden(parseFrontmatter(md).body);
  const out: string[] = [];
  for (const l of findWikiLinks(body)) if (isAttachmentPath(l.target)) out.push(l.target);
  for (const m of maskCode(body).matchAll(MD_LINK)) if (!EXTERNAL.test(m[2]!) && !m[2]!.startsWith("#") && isAttachmentPath(safeDecode(m[2]!))) out.push(m[2]!);
  return out.map((t) => resolveFile(files, notePath, t)).filter((f): f is string => !!f);
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
/** From a page to the site's root: "./" at the top, "../../" two folders down. */
const rootFrom = (page: string) => "../".repeat(page.split("/").length - 1) || "./";

export function headingId(text: string): string {
  return (
    plainInline(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

// Raw HTML in a note keeps a few formatting tags, never attributes; script-like elements go with
// their content, everything else leaves its text.
const KEEP = new Set(["b", "i", "em", "strong", "u", "s", "del", "ins", "sub", "sup", "kbd", "mark", "small", "span", "div", "p", "br", "hr", "details", "summary", "center"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "textarea", "select", "svg", "math", "title", "head", "frameset", "frame"]);
function cleanHtml(src: string): string {
  let out = "";
  let skip: string | null = null;
  for (const m of src.matchAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>|[^<]+|</g)) {
    const [all, close, tag] = m;
    if (all.startsWith("<!--")) continue;
    if (tag) {
      const t = tag.toLowerCase();
      if (skip) {
        if (close && t === skip) skip = null;
      } else if (DROP.has(t)) {
        if (!close && !all.endsWith("/>")) skip = t;
      } else if (KEEP.has(t)) out += t === "br" || t === "hr" ? (close ? "" : `<${t}>`) : `<${close}${t}>`;
      continue;
    }
    if (!skip) out += all.replace(/&(?!(?:[a-z]+|#\d+|#x[\da-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return out;
}

interface RenderCtx {
  /** Every note in the vault, so a link resolves as it does in the app. */
  all: Parameters<typeof resolveLocal>[0];
  /** Published notes by id. */
  published: Map<number, Chosen>;
  /** Files the snapshot holds. */
  files: string[];
}

function renderNote(note: Chosen, from: string, c: RenderCtx, depth = 0): string {
  const root = rootFrom(from);
  const ids = new Map<string, number>();
  const pageHref = (n: Chosen, hash = "") => root + encodePath(pagePath(n.path)) + hash;
  const fileHref = (f: string) => root + encodePath(f);
  const anchor = (target: string) => {
    const h = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
    return h && !h.startsWith("^") ? "#" + encodeURIComponent(headingId(h)) : "";
  };
  const published = (target: string) => {
    const hit = resolveLocal(c.all, target);
    return hit ? c.published.get(hit.id) : undefined;
  };
  const fileEmbed = (path: string, alt?: string) => {
    const href = esc(fileHref(path));
    const size = /^(\d+)(?:x(\d+))?$/.exec(alt ?? "");
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i.test(path)) return `<img src="${href}" alt="${esc(size ? "" : (alt ?? ""))}" loading="lazy"${size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : ""}>`;
    if (/\.(mp3|m4a|wav|ogg)$/i.test(path)) return `<audio controls src="${href}"></audio>`;
    if (/\.(mp4|mov|webm)$/i.test(path)) return `<video controls src="${href}"></video>`;
    return `<a href="${href}">${esc(alt || path.split("/").pop()!)}</a>`;
  };
  /** ![[Note]] or ![[Note#Heading]], as a block: the other page's text, one level deep. */
  const noteEmbed = (target: string): string | null => {
    const n = published(target);
    if (!n || depth > 0) return null;
    const body = stripHidden(parseFrontmatter(n.content).body);
    const h = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
    let part = body;
    if (h.startsWith("^")) part = body.split("\n").find((l) => l.trimEnd().endsWith(h)) ?? body;
    else if (h) {
      const r = sectionRange(body, h);
      if (r) part = body.slice(r.from, r.to);
    }
    return `<div class="site-embed"><a class="internal-link" href="${esc(pageHref(n, anchor(target)))}">${esc(n.title)}</a>${renderNote({ ...n, content: part }, from, c, depth + 1)}</div>`;
  };

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => src.match(/!?\[\[/)?.index,
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]/.exec(src);
          if (m) return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), alias: m[3]?.trim() };
        },
        renderer(t: any) {
          const target: string = t.target;
          if (isAttachmentPath(target)) {
            const f = resolveFile(c.files, note.path, target);
            if (!f) return esc(t.alias && !/^\d+(x\d+)?$/.test(t.alias) ? t.alias : target.split("/").pop()!);
            return t.embed ? fileEmbed(f, t.alias) : `<a href="${esc(fileHref(f))}">${esc(t.alias || target)}</a>`;
          }
          // What the note says, never the title of a note that isn't published.
          const label = esc(t.alias || target.replace(/#\^?/, " › "));
          const n = published(target);
          if (!n) return label;
          return `<a class="internal-link" href="${esc(pageHref(n, anchor(target)))}">${t.embed ? "↪ " : ""}${label}</a>`;
        },
      },
      {
        name: "highlight",
        level: "inline",
        start: (src: string) => src.indexOf("=="),
        tokenizer(src: string) {
          const m = /^==(?=\S)([^=\n]+?)==/.exec(src);
          if (!m) return;
          const hilo = hiloColour(m[1]!);
          return { type: "highlight", raw: m[0], colour: hilo?.name ?? null, tokens: this.lexer.inlineTokens(hilo ? hilo.text : m[1]!) };
        },
        renderer(t: any) {
          return `<mark${t.colour ? ` class="hl-${t.colour}"` : ""}>${this.parser.parseInline(t.tokens)}</mark>`;
        },
      },
      {
        name: "tag",
        level: "inline",
        start: (src: string) => src.match(/(^|\s)#[\p{L}_\-/]/u)?.index,
        tokenizer(src: string) {
          const m = /^(\s?)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
          if (m) return { type: "tag", raw: m[0], lead: m[1], tag: m[2] };
        },
        renderer(t: any) {
          return `${t.lead}<span class="tag">#${esc(t.tag)}</span>`;
        },
      },
    ],
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return cleanHtml(text);
      },
      heading({ tokens, depth: level }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = headingId(tokens.map((t) => t.raw).join(""));
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        return `<h${level} id="${esc(n ? `${base}-${n}` : base)}">${inner}</h${level}>\n`;
      },
      checkbox({ checked }: Tokens.Checkbox) {
        return `<input type="checkbox" class="task" disabled${checked ? " checked" : ""} aria-label="${checked ? "Done" : "To do"}"> `;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (/^(https?|mailto):/i.test(href)) return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer nofollow">${text}</a>`;
        if (EXTERNAL.test(href)) return text; // javascript:, data: and the like: just the words
        if (href.startsWith("#")) return `<a href="#${encodeURIComponent(headingId(safeDecode(href.slice(1))))}">${text}</a>`;
        if (isAttachmentPath(safeDecode(href))) {
          const f = resolveFile(c.files, note.path, href);
          return f ? `<a href="${esc(fileHref(f))}">${text}</a>` : text;
        }
        const n = published(safeDecode(href));
        return n ? `<a class="internal-link" href="${esc(pageHref(n, anchor(safeDecode(href))))}">${text}</a>` : text;
      },
      image({ href, title, text }: Tokens.Image) {
        if (/^https?:/i.test(href) || /^data:image\/(png|jpe?g|gif|webp);/i.test(href)) return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`;
        const f = EXTERNAL.test(href) ? undefined : resolveFile(c.files, note.path, href);
        return f ? fileEmbed(f, text) : esc(text);
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        // A note embed alone in its paragraph becomes a block holding the other page's text.
        const only = tokens.filter((x) => !(x.type === "text" && !x.raw.trim()));
        const one = only.length === 1 ? (only[0] as any) : null;
        if (one?.type === "wikilink" && one.embed && !isAttachmentPath(one.target)) {
          const block = noteEmbed(one.target);
          if (block) return block + "\n";
        }
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens);
        const m = /^<p>\[!([\w-]+)\][+-]?[ \t]*([^\n<]*)(?:\n|<br>)?/i.exec(inner);
        if (!m) return `<blockquote>${inner}</blockquote>`;
        const type = m[1]!.toLowerCase();
        const title = m[2]!.trim() || type[0]!.toUpperCase() + type.slice(1);
        let rest = inner.slice(m[0].length);
        rest = /^\s*<\/p>/.test(rest) ? rest.replace(/^\s*<\/p>/, "") : `<p>${rest}`;
        return `<div class="callout" data-callout="${esc(type)}"><div class="callout-title">${esc(title)}</div><div class="callout-body">${rest}</div></div>`;
      },
    },
  });

  let body = stripHidden(parseFrontmatter(note.content).body);
  // The page shows the title; a first heading that only repeats it is dropped.
  if (depth === 0) {
    const first = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(body);
    if (first && plainInline(first[1]!).toLowerCase() === note.title.toLowerCase()) body = body.slice(first[0].length);
  }
  return marked.parse(body, { async: false }) as string;
}

// ── publish, state, take down ─────────────────────────────────────────────────────────────

interface Plan {
  settings: SiteSettings;
  pages: Chosen[];
  held: string[];
  files: string[];
}

async function plan(vaultId: number): Promise<Plan & { error?: string }> {
  const { settings, error } = await readSettings(vaultId);
  if (error) return { settings, error, pages: [], held: [], files: [] };
  const { pages, held } = await choose(vaultId, settings);
  const all = (await sql<{ path: string }[]>`select path from attachments where vault_id = ${vaultId} and path <> ${SITE_SETTINGS}`).map((f) => f.path);
  const files = new Set<string>();
  for (const p of pages) for (const f of fileRefs(all, p.path, p.content)) files.add(f);
  return { settings, pages, held, files: [...files].sort() };
}

const newSlug = () => randomBytes(8).readBigUInt64BE().toString(36).padStart(12, "0").slice(0, 12);

export async function publish(vaultId: number, user: User): Promise<{ slug: string; pages: number; files: number }> {
  const p = await plan(vaultId);
  if (p.error) throw new HttpError(400, p.error);
  if (!p.pages.length) throw new HttpError(400, "Nothing to publish: the chosen folders have no notes, or every note says publish: false.");
  const [vault] = await sql`select name from vaults where id = ${vaultId}`;
  const ctx: RenderCtx = { all: (await listNotes(vaultId)) as RenderCtx["all"], published: new Map(p.pages.map((n) => [n.id, n])), files: p.files };
  const rows = p.pages.map((n) => ({ vault_id: vaultId, path: pagePath(n.path), note_path: n.path, title: n.title, html: renderNote(n, pagePath(n.path), ctx), source_md5: n.md5 }));
  const [{ bytes }] = (await sql`select coalesce(sum(size), 0)::float8 as bytes from attachments where vault_id = ${vaultId} and path = any(${p.files})`) as unknown as [{ bytes: number }];
  await assertRoom(bytes + rows.reduce((n, r) => n + r.html.length, 0));

  const settings = { ...p.settings, title: p.settings.title || vault!.name };
  const slug = await sql.begin(async (tx) => {
    const [s] = await tx`insert into sites (vault_id, slug) values (${vaultId}, ${newSlug()})
                         on conflict (vault_id) do update set vault_id = excluded.vault_id returning slug`;
    await tx`delete from site_pages where vault_id = ${vaultId}`;
    await tx`delete from site_files where vault_id = ${vaultId}`;
    for (let i = 0; i < rows.length; i += 500) await tx`insert into site_pages ${tx(rows.slice(i, i + 500))} on conflict do nothing`;
    await tx`insert into site_files (vault_id, path, mime, data)
             select vault_id, path, mime, data from attachments where vault_id = ${vaultId} and path = any(${p.files})`;
    await tx`update sites set live = true, settings = ${tx.json(settings as any)}, published_at = now(), published_by = ${user.id} where vault_id = ${vaultId}`;
    return s!.slug as string;
  });
  return { slug, pages: rows.length, files: p.files.length };
}

/** Take the site down (keeping the snapshot, so Undo puts the same pages back), or put it back. */
export async function setLive(vaultId: number, live: boolean): Promise<void> {
  const r = await sql`update sites set live = ${live} where vault_id = ${vaultId} and published_at is not null returning 1`;
  if (!r.length) throw new HttpError(404, "This vault hasn't been published");
}

const LIST_MAX = 500;

/** Everything the Website settings show: the choice, what would be public, and what a republish
 *  would add, change or take down. */
export async function siteState(vaultId: number) {
  const p = await plan(vaultId);
  const folders = [...new Set((await sql<{ path: string }[]>`select path from notes where vault_id = ${vaultId}`).flatMap((n) => n.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))))].sort((a, b) => a.localeCompare(b));
  const [site] = await sql`
    select s.slug, s.live, s.settings, s.published_at, u.name as published_by,
           (select count(*)::int from site_pages sp where sp.vault_id = s.vault_id) as pages,
           (select count(*)::int from site_files sf where sf.vault_id = s.vault_id) as files
    from sites s left join users u on u.id = s.published_by where s.vault_id = ${vaultId} and s.published_at is not null`;
  let changes = null;
  if (site) {
    const was = new Map((await sql<{ note_path: string; source_md5: string }[]>`select note_path, source_md5 from site_pages where vault_id = ${vaultId}`).map((r) => [r.note_path, r.source_md5]));
    const now = new Set(p.pages.map((n) => n.path));
    changes = {
      added: p.pages.filter((n) => !was.has(n.path)).map((n) => n.path),
      changed: p.pages.filter((n) => was.has(n.path) && was.get(n.path) !== n.md5).map((n) => n.path),
      removed: [...was.keys()].filter((path) => !now.has(path)).sort(),
      settings: JSON.stringify(site.settings.include ?? []) !== JSON.stringify(p.settings.include),
    };
    for (const k of ["added", "changed", "removed"] as const) changes[k] = changes[k].slice(0, LIST_MAX);
  }
  return {
    settings: p.settings,
    error: p.error ?? null,
    folders,
    notes: p.pages.slice(0, LIST_MAX).map((n) => n.path),
    noteCount: p.pages.length,
    held: p.held.slice(0, LIST_MAX),
    files: p.files.slice(0, LIST_MAX),
    fileCount: p.files.length,
    site: site ? { slug: site.slug as string, live: site.live as boolean, publishedAt: site.published_at as string, publishedBy: (site.published_by as string | null) ?? null, pages: site.pages as number, files: site.files as number } : null,
    changes,
  };
}

// ── serving /p/<slug>/… ───────────────────────────────────────────────────────────────────

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // No script, no forms, no framing; sandboxed, so a page never acts as the app's origin.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self' https: data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  // Unlisted (the default): search engines are asked to leave it out.
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Taking a site down or republishing shows at once.
  "Cache-Control": "no-cache",
};

let css: string | null = null;
async function stylesheet(): Promise<string> {
  if (css) return css;
  const part = (f: string) => Bun.file(new URL(`../web/styles/${f}`, import.meta.url)).text();
  return (css = (await Promise.all(["tokens.css", "markdown.css", "site.css"].map(part))).join("\n"));
}

function shell(site: { title: string }, from: string, title: string, main: string, isPage = false): string {
  const root = rootFrom(from);
  // A page's folders, as words: folders have no pages of their own (yet).
  const crumbs = isPage ? from.split("/").slice(0, -1) : [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title === site.title ? title : `${title} · ${site.title}`)}</title>
<link rel="stylesheet" href="${root}_site/style.css">
</head>
<body class="site">
<a class="site-skip" href="#main">Skip to the text</a>
<header class="site-head">
<a class="site-name" href="${root}">${esc(site.title)}</a>
<nav aria-label="Site"><a href="${root}_site/pages">All pages</a></nav>
</header>
<main id="main" class="site-main markdown">
${crumbs.length ? `<p class="site-crumbs">${crumbs.map(esc).join(" › ")}</p>\n` : ""}${main}
</main>
</body>
</html>`;
}

const notFound = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body><main><h1>This page isn't here</h1><p>It may have been taken down, or the link is wrong.</p></main></body></html>`,
    { status: 404, headers: PAGE_HEADERS },
  );

/** A top-level note called index, Home or README is the site's home page. */
const HOME = ["index", "home", "readme"];

function pagesList(pages: { path: string; title: string }[], from: string): string {
  const root = rootFrom(from);
  const groups = new Map<string, typeof pages>();
  for (const p of pages) {
    const folder = p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "";
    groups.set(folder, [...(groups.get(folder) ?? []), p]);
  }
  const list = (ps: typeof pages) => `<ul>${ps.map((p) => `<li><a class="internal-link" href="${esc(root + encodePath(p.path))}">${esc(p.title)}</a></li>`).join("")}</ul>`;
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, ps]) => (folder ? `<h2>${esc(folder.split("/").join(" › "))}</h2>` : "") + list(ps))
    .join("\n");
}

export async function serveSite(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(req.url);
  const m = /^\/p\/([a-z0-9]{6,32})(\/.*)?$/.exec(url.pathname);
  if (!m) return notFound();
  if (m[2] === undefined) return new Response(null, { status: 308, headers: { Location: `/p/${m[1]}/` } });
  const [site] = await sql`select vault_id, settings from sites where slug = ${m[1]!} and live`;
  if (!site) return notFound();
  let path: string;
  try {
    path = decodeURIComponent(m[2].slice(1));
  } catch {
    return notFound();
  }
  const meta = { title: String(site.settings.title ?? "") || "Notes" };

  if (path === "_site/style.css") return new Response(await stylesheet(), { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  if (path === "" || path === "_site/pages") {
    const pages = await sql<{ path: string; title: string; html: string }[]>`select path, title, html from site_pages where vault_id = ${site.vault_id} order by lower(path)`;
    const home = path === "" ? HOME.map((h) => pages.find((p) => p.path.toLowerCase() === h)).find(Boolean) : undefined;
    if (home) return new Response(shell(meta, "", meta.title, `<h1>${esc(home.title)}</h1>\n${home.html}`), { headers: PAGE_HEADERS });
    const from = path === "" ? "" : "_site/pages";
    return new Response(shell(meta, from, path === "" ? meta.title : "All pages", `<h1>${esc(path === "" ? meta.title : "All pages")}</h1>\n${pagesList(pages, from)}`), { headers: PAGE_HEADERS });
  }

  const [page] = await sql`select title, html from site_pages where vault_id = ${site.vault_id} and path = ${path}`;
  if (page) return new Response(shell(meta, path, page.title, `<h1>${esc(page.title)}</h1>\n${page.html}`, true), { headers: PAGE_HEADERS });
  const [file] = await sql`select mime, data from site_files where vault_id = ${site.vault_id} and path = ${path}`;
  if (file)
    return new Response(new Uint8Array(file.data), {
      headers: { "Content-Type": file.mime, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
    });
  return notFound();
}
