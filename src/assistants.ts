// Bring your own AI (F13): each person adds assistants with their own API key, and a daily £
// limit (£1 unless changed) checked against a ledger of what each model call cost. Keys are sealed
// with SECRETS_KEY (src/secrets.ts), never shared with vault members, and never sent back to the
// browser; only the last four characters are shown. Calls go through this server, which runs the
// tools (src/ai.ts), and the key travels only in a header to the provider.

import { isIP } from "node:net";
import { isPrivateAddress } from "./addresses";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { complete, DEFAULT_BASE, type Provider, ProviderError, type Usage } from "./llm";
import { costOf, listPrice, type Price, pounds } from "./prices";
import { settings } from "./settings";
import { open, seal } from "./secrets";

export interface Assistant {
  id: number;
  name: string;
  provider: Provider;
  base_url: string;
  model: string;
  key_hint: string;
  created_at: string;
  last_used_at: string | null;
  /** £ per million tokens: the assistant's own, else the list price, else null (unknown). */
  price: Price | null;
  /** Own price set, rather than the list price. */
  custom_price: boolean;
  /** £ a day, or null for no limit. */
  daily_cap: number | null;
  spent_today: number;
}
export interface AssistantWithKey extends Assistant {
  apiKey: string;
}

export const PROVIDERS: Record<Provider, { label: string; defaultModel: string; baseUrl: string }> = {
  anthropic: { label: "Anthropic", defaultModel: "claude-opus-5-5", baseUrl: DEFAULT_BASE.anthropic },
  openai: { label: "OpenAI", defaultModel: "gpt-6.1-sol", baseUrl: DEFAULT_BASE.openai },
  relaxai: { label: "relaxAI", defaultModel: "DeepSeek-V4-Pro", baseUrl: DEFAULT_BASE.relaxai },
  compatible: { label: "OpenAI-compatible", defaultModel: "", baseUrl: "" },
};

const NAME = /^[\p{L}\p{N}]{1,30}$/u;

export interface Draft {
  name: string;
  provider: Provider;
  baseUrl?: string;
  model?: string;
  apiKey: string;
  /** Own price, £ per million tokens; null or absent uses the list price. */
  price?: Price | null;
  /** £ a day; null for none. */
  dailyCap?: number | null;
}

/** Today in the server's time zone, as YYYY-MM-DD: the ledger's day. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function checkMoney(d: Pick<Draft, "price" | "dailyCap" | "provider" | "model">, model: string) {
  if (d.price && (!(d.price.in >= 0) || !(d.price.out >= 0) || d.price.in > 1000 || d.price.out > 1000)) throw new HttpError(400, "Prices are £ per million tokens, between 0 and 1000");
  if (d.dailyCap != null && (!(d.dailyCap > 0) || d.dailyCap > 1000)) throw new HttpError(400, "The daily limit is in £, more than 0 and at most 1000");
  if (d.dailyCap != null && !d.price && !listPrice(d.provider, model)) throw new HttpError(400, "To keep to a daily limit it needs the model's price: enter £ per million tokens in and out");
}

/** A base URL the server may call: https, or http only to this machine (in development, or with
 *  ALLOW_LOCAL_AI=true for a model on the same host as the server). */
export function checkBaseUrl(provider: Provider, raw: string | undefined): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) {
    if (provider === "compatible") throw new HttpError(400, "An OpenAI-compatible provider needs its base URL, e.g. https://openrouter.ai/api/v1");
    return "";
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new HttpError(400, "That base URL isn't a URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  // Never a private or internal address the server can reach but the person can't (SSRF).
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const internal = !local && ((isIP(host) && isPrivateAddress(host)) || /\.localhost$|\.local$|\.internal$/i.test(host));
  if (internal) throw new HttpError(400, "That base URL is a private address. Give it a public https URL.");
  if (u.protocol === "https:" && !local) return v;
  if (u.protocol === "http:" && local && (process.env.NODE_ENV !== "production" || process.env.ALLOW_LOCAL_AI === "true")) return v;
  if (local) throw new HttpError(400, "The server can't reach a model on your own computer. Give it a public https URL (e.g. through a tunnel).");
  throw new HttpError(400, "The base URL must start with https://");
}

function checkName(name: string) {
  const n = name.trim();
  if (!NAME.test(n)) throw new HttpError(400, "Name it with letters and digits only, like Claude or Scribe (you'll type @name)");
  return n;
}

const hint = (key: string) => key.trim().slice(-4);

type Row = Omit<Assistant, "price" | "custom_price" | "daily_cap" | "spent_today"> & { price_in: string | null; price_out: string | null; daily_cap: string | null; spent_today: string };

const shape = (r: Row): Assistant => {
  const { price_in, price_out, daily_cap, spent_today, ...rest } = r;
  const own = price_in !== null && price_out !== null ? { in: Number(price_in), out: Number(price_out) } : null;
  return { ...rest, id: Number(rest.id), price: own ?? listPrice(r.provider, r.model), custom_price: !!own, daily_cap: daily_cap === null ? null : Number(daily_cap), spent_today: Number(spent_today) };
};

export async function listAssistants(userId: number): Promise<Assistant[]> {
  const rows = await sql<Row[]>`
    select a.id, a.name, a.provider, a.base_url, a.model, a.key_hint, a.created_at, a.last_used_at,
           a.price_in, a.price_out, a.daily_cap, coalesce(u.cost_gbp, 0) as spent_today
    from user_assistants a left join ai_usage u on u.assistant_id = a.id and u.day = ${today()}
    where a.user_id = ${userId} order by lower(a.name)`;
  return rows.map(shape);
}

export async function createAssistant(user: User, d: Draft): Promise<Assistant> {
  const name = checkName(d.name);
  const baseUrl = checkBaseUrl(d.provider, d.baseUrl);
  const model = (d.model ?? "").trim() || PROVIDERS[d.provider].defaultModel;
  if (!model) throw new HttpError(400, "Which model? e.g. anthropic/claude-opus-5-5");
  if (!d.apiKey.trim()) throw new HttpError(400, "Paste the API key");
  // £1 a day unless told otherwise, where the price is known (the app always says).
  const cap = d.dailyCap !== undefined ? d.dailyCap : d.price || listPrice(d.provider, model) ? 1 : null;
  checkMoney({ ...d, dailyCap: cap }, model);
  const [{ n }] = (await sql`select count(*)::int as n from user_assistants where user_id = ${user.id} and lower(name) = lower(${name})`) as any;
  if (n) throw new HttpError(409, `You already have an assistant called ${name}`);
  const [r] = await sql`
    insert into user_assistants (user_id, name, provider, base_url, model, key_enc, key_hint, price_in, price_out, daily_cap)
    values (${user.id}, ${name}, ${d.provider}, ${baseUrl}, ${model}, ${seal(d.apiKey.trim())}, ${hint(d.apiKey)},
            ${d.price?.in ?? null}, ${d.price?.out ?? null}, ${cap})
    returning id`;
  return (await listAssistants(user.id)).find((a) => a.id === Number(r!.id))!;
}

export async function updateAssistant(user: User, id: number, d: Partial<Draft>): Promise<Assistant> {
  const cur = await getAssistant(user.id, id);
  const name = d.name !== undefined ? checkName(d.name) : cur.name;
  if (name.toLowerCase() !== cur.name.toLowerCase()) {
    const [{ n }] = (await sql`select count(*)::int as n from user_assistants where user_id = ${user.id} and lower(name) = lower(${name})`) as any;
    if (n) throw new HttpError(409, `You already have an assistant called ${name}`);
  }
  const provider = d.provider ?? cur.provider;
  const baseUrl = d.baseUrl !== undefined || d.provider ? checkBaseUrl(provider, d.baseUrl ?? cur.base_url) : cur.base_url;
  const model = d.model?.trim() || cur.model;
  const key = d.apiKey?.trim();
  const own = cur.price_in !== null && cur.price_out !== null ? { in: Number(cur.price_in), out: Number(cur.price_out) } : null;
  const price = d.price !== undefined ? d.price : own;
  const cap = d.dailyCap !== undefined ? d.dailyCap : cur.daily_cap === null ? null : Number(cur.daily_cap);
  checkMoney({ provider, model, price, dailyCap: cap }, model);
  await sql`
    update user_assistants set name = ${name}, provider = ${provider}, base_url = ${baseUrl}, model = ${model},
      key_enc = ${key ? seal(key) : sql`key_enc`}, key_hint = ${key ? hint(key) : sql`key_hint`},
      price_in = ${price?.in ?? null}, price_out = ${price?.out ?? null}, daily_cap = ${cap}
    where id = ${id} and user_id = ${user.id}`;
  return (await listAssistants(user.id)).find((a) => a.id === id)!;
}

export async function deleteAssistant(userId: number, id: number): Promise<void> {
  const r = await sql`delete from user_assistants where id = ${id} and user_id = ${userId} returning id`;
  if (!r.length) throw new HttpError(404, "Assistant not found");
}

async function getAssistant(userId: number, id: number) {
  const [a] = await sql`select * from user_assistants where id = ${id} and user_id = ${userId}`;
  if (!a) throw new HttpError(404, "Assistant not found");
  return a as Row & { key_enc: string };
}

/** The assistant with its key opened, for a call to the provider. Only ever the owner's. */
export async function withKey(userId: number, id: number): Promise<AssistantWithKey> {
  const a = (await listAssistants(userId)).find((x) => x.id === id);
  if (!a) throw new HttpError(404, "Assistant not found");
  const { key_enc } = await getAssistant(userId, id);
  return { ...a, apiKey: open(key_enc) };
}

/** The daily limit, checked before every model call: a 429 saying so once today's spend reaches it. */
export async function checkBudget(a: Assistant): Promise<void> {
  if (a.daily_cap === null) return;
  const [u] = await sql`select cost_gbp from ai_usage where assistant_id = ${a.id} and day = ${today()}`;
  const spent = Number(u?.cost_gbp ?? 0);
  if (spent >= a.daily_cap)
    throw new HttpError(429, `${a.name} has used its ${pounds(a.daily_cap)} for today (${pounds(spent)}). It starts again tomorrow, or raise the limit in Settings → AI assistants.`);
}

/** Add one model call to today's ledger; returns what it cost (£, 0 if the price is unknown). */
export async function record(a: Assistant, u: Usage): Promise<number> {
  const cost = a.price ? costOf(a.price, u) : 0;
  await sql`
    insert into ai_usage (assistant_id, day, input_tokens, output_tokens, cost_gbp, calls)
    values (${a.id}, ${today()}, ${u.input + u.cacheRead + u.cacheWrite}, ${u.output}, ${cost}, 1)
    on conflict (assistant_id, day) do update set
      input_tokens = ai_usage.input_tokens + excluded.input_tokens,
      output_tokens = ai_usage.output_tokens + excluded.output_tokens,
      cost_gbp = ai_usage.cost_gbp + excluded.cost_gbp,
      calls = ai_usage.calls + 1`;
  return cost;
}

export async function touch(id: number) {
  await sql`update user_assistants set last_used_at = now() where id = ${id}`;
}

/** One tiny request, so the dialog can say the key and model work. */
export async function testAssistant(user: User, input: { id?: number; draft?: Draft }): Promise<{ ok: true; reply: string }> {
  let a: Pick<AssistantWithKey, "provider" | "base_url" | "model" | "apiKey">;
  let saved: AssistantWithKey | null = null;
  if (input.id) a = saved = await withKey(user.id, input.id);
  else if (input.draft) {
    const d = input.draft;
    // Testing a saved assistant with a new key: the draft carries the id's other settings.
    a = {
      provider: d.provider,
      base_url: checkBaseUrl(d.provider, d.baseUrl),
      model: d.model?.trim() || PROVIDERS[d.provider].defaultModel,
      apiKey: d.apiKey.trim(),
    };
    if (!a.apiKey) throw new HttpError(400, "Paste the API key");
  } else throw new HttpError(400, "Nothing to test");
  let out;
  try {
    if (saved) await checkBudget(saved);
    out = await complete(a, "Reply with just the word: ready", [{ role: "user", text: "Are you there?" }], [], AbortSignal.timeout(30_000), () => {});
    if (saved) await record(saved, out.usage);
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(e.status, e.message);
    if (e instanceof Error && e.name === "TimeoutError") throw new HttpError(504, "The provider didn't answer within 30 seconds");
    throw e;
  }
  return { ok: true, reply: out.text.trim().slice(0, 200) };
}
