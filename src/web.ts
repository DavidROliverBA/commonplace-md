// The in-app assistant on the web: web_search (Brave Search, with each person's own key) and
// read_web_page (any public page, fetched by src/weblinks.ts's safeFetch, so never a private
// address). Only the in-app assistant gets these, never MCP agents, and only when its owner has
// allowed it (user_assistants.web) and the conversation has turned it on (the globe in the panel).
//
// What a page says is untrusted: it could tell the model to send your notes somewhere in a URL or
// a search. So once a conversation has read anything from the web, every further web request and
// every change asks the person first (src/ai.ts), and they see the exact address or search. Opening
// a link that a search returned doesn't ask: the address came from Brave, not from the model.

import { z } from "zod";
import { HttpError } from "./auth";
import { sql } from "./db";
import type { ToolSpec } from "./llm";
import { open, seal } from "./secrets";
import { settings } from "./settings";
import { decodeEntities, readCapped, safeFetch } from "./weblinks";

const MAX_PAGE = 1_500_000;
/** Text of a page given to the model: enough for an article, not a whole site. */
const PAGE_CHARS = 20_000;
const RESULTS = 6;

// ── the search key ───────────────────────────────────────────────────────────────────────

const hint = (k: string) => k.trim().slice(-4);

export async function connection(userId: number): Promise<{ provider: string; key_hint: string } | null> {
  const [r] = await sql`select provider, key_hint from user_search where user_id = ${userId}`;
  return r ? { provider: r.provider, key_hint: r.key_hint } : null;
}

/** Check a Brave Search key with one search, then keep it sealed. */
export async function connect(userId: number, raw: string): Promise<{ provider: string; key_hint: string }> {
  const key = raw.trim();
  if (key.length < 10) throw new HttpError(400, "Paste the Brave Search API key");
  await brave(key, "Commonplace", 1);
  await sql`insert into user_search (user_id, provider, key_enc, key_hint) values (${userId}, 'brave', ${seal(key)}, ${hint(key)})
            on conflict (user_id) do update set key_enc = excluded.key_enc, key_hint = excluded.key_hint, created_at = now()`;
  return { provider: "brave", key_hint: hint(key) };
}

export async function disconnect(userId: number): Promise<void> {
  await sql`delete from user_search where user_id = ${userId}`;
}

async function keyFor(userId: number): Promise<string> {
  const [r] = await sql`select key_enc from user_search where user_id = ${userId}`;
  if (!r) throw new HttpError(409, "Web search needs a Brave Search key: Settings → AI assistants → Web search.");
  try {
    return open(r.key_enc);
  } catch {
    throw new HttpError(409, "Your web search key can't be read any more (the server's SECRETS_KEY changed): add it again in Settings → AI assistants.");
  }
}

// ── searching ────────────────────────────────────────────────────────────────────────────

export interface Hit {
  title: string;
  url: string;
  description: string;
}

const plain = (s: string) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, "")).trim();

async function brave(key: string, query: string, count: number): Promise<Hit[]> {
  let res: Response;
  try {
    res = await fetch(`${settings.braveApi}/web/search?${new URLSearchParams({ q: query, count: String(count), safesearch: "moderate" })}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Brave Search. Try again in a moment.");
  }
  if (res.status === 401 || res.status === 403 || res.status === 422) throw new HttpError(409, "Brave Search refused the key: check it in Settings → AI assistants → Web search.");
  if (res.status === 429) throw new HttpError(429, "The Brave Search key's limit is used up for now.");
  if (!res.ok) throw new HttpError(502, `Brave Search said: error ${res.status}`);
  const data = (await res.json()) as any;
  return ((data?.web?.results ?? []) as any[]).slice(0, count).map((r) => ({ title: plain(r.title), url: String(r.url), description: plain(r.description) }));
}

export async function search(userId: number, query: string): Promise<{ query: string; results: Hit[] }> {
  return { query, results: await brave(await keyFor(userId), query, RESULTS) };
}

// ── reading a page ───────────────────────────────────────────────────────────────────────

/** A page's readable text: its main part if it marks one, without scripts, menus and footers;
 *  headings, paragraphs, list items and table rows on lines of their own. */
export function pageText(html: string): { title: string; text: string } {
  const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  body = /<article[\s>][\s\S]*<\/article>/i.exec(body)?.[0] ?? /<main[\s>][\s\S]*<\/main>/i.exec(body)?.[0] ?? body;
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|h[1-6]|tr|blockquote|pre|table|ul|ol|dl|dd|dt|figure)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function readPage(raw: string): Promise<{ url: string; title: string; text: string; cut: boolean }> {
  const { res, url } = await safeFetch(raw, "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,*/*;q=0.1");
  if (!res.ok) {
    void res.body?.cancel();
    throw new HttpError(502, `The page answered ${res.status}`);
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !/text\/|html|xml|json|markdown/.test(type)) {
    void res.body?.cancel();
    throw new HttpError(415, `That isn't a page of text (it's ${type.split(";")[0]})`);
  }
  const raw2 = new TextDecoder().decode(await readCapped(res, MAX_PAGE));
  const { title, text } = /html|xml/.test(type) || /<html[\s>]/i.test(raw2) ? pageText(raw2) : { title: "", text: raw2.trim() };
  return { url: url.toString(), title, text: text.slice(0, PAGE_CHARS), cut: text.length > PAGE_CHARS };
}

// ── the tools ────────────────────────────────────────────────────────────────────────────

export const WEB_TOOLS = ["web_search", "read_web_page"] as const;
export const isWebTool = (name: string) => (WEB_TOOLS as readonly string[]).includes(name);

const SearchInput = z.object({ query: z.string().min(1).max(300) });
const PageInput = z.object({ url: z.string().min(1).max(2000) });

/** The web tools to offer: reading pages always, searching once there's a key. */
export async function webSpecs(userId: number): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  if (await connection(userId))
    specs.push({
      name: "web_search",
      description: "Search the web. Returns titles, links and snippets. Use it for things your notes don't cover or that may have changed; then read_web_page the useful results.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
    });
  specs.push({
    name: "read_web_page",
    description: "Read a public web page and get its text (up to about 20,000 characters). Use links from web_search, from notes, or that the person gave you.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "The page's full https:// address" } }, required: ["url"] },
  });
  return specs;
}

export async function callWebTool(userId: number, name: string, input: unknown): Promise<unknown> {
  const parse = <T,>(schema: z.ZodType<T>) => {
    const r = schema.safeParse(input);
    if (!r.success) throw new HttpError(400, `${name} needs ${name === "web_search" ? "a query" : "a url"}`);
    return r.data;
  };
  if (name === "web_search") return search(userId, parse(SearchInput).query);
  if (name === "read_web_page") return readPage(parse(PageInput).url);
  throw new HttpError(400, `No tool called ${name}`);
}

/** What a web request would send out, for the person to allow. */
export function describeWebCall(name: string, input: Record<string, unknown>): string {
  return name === "web_search" ? `Search the web for “${String(input.query ?? "")}”` : `Open ${String(input.url ?? "")}`;
}
