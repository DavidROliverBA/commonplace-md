// Talking to AI providers (F13): Anthropic's Messages API and OpenAI's Chat Completions (which
// relaxAI, OpenRouter and most self-hosted servers also speak), streamed, with tool use. Conversations are
// kept in one neutral shape (`Msg`) and translated per provider here, so the rest of the app never
// sees a provider's format. Keys go only in headers.

export type Provider = "anthropic" | "openai" | "relaxai" | "compatible";

/** Where each provider is when no base URL is given. */
export const DEFAULT_BASE: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  // relaxAI (Civo Ltd): UK company, UK datacentre (LON1), OpenAI-compatible, billed in £.
  relaxai: "https://api.relax.ai/v1",
  compatible: "",
};

export interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface Result {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}
export type Msg = { role: "user"; text: string } | { role: "assistant"; text: string; calls: Call[] } | { role: "tool"; results: Result[] };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
/** Tokens one call used. `input` is what's billed at the full input price; prompt-cache reads
 *  and writes are counted apart, as they're billed differently (src/prices.ts). */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface Completion {
  text: string;
  calls: Call[];
  usage: Usage;
  /** "end", "tools", or "length" when the reply was cut off at the token limit. */
  stop: "end" | "tools" | "length";
}

interface Target {
  provider: Provider;
  base_url: string;
  model: string;
  apiKey: string;
}

const MAX_TOKENS = 16_000;
/** relaxAI's models reason before answering, and the reasoning counts against max_tokens (as
 *  Longview found, 2026-08-29), so give them room. Accepted by every relaxAI model, 2026-10-11. */
const RELAX_MAX_TOKENS = 32_000;

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One model turn: streams text through `onText`, and returns the whole reply with any tool calls. */
export async function complete(t: Target, system: string, messages: Msg[], tools: ToolSpec[], signal: AbortSignal, onText: (delta: string) => void): Promise<Completion> {
  return t.provider === "anthropic" ? anthropic(t, system, messages, tools, signal, onText) : openai(t, system, messages, tools, signal, onText);
}

// ── Anthropic ───────────────────────────────────────────────────────────────────────────────

function anthropicMessages(messages: Msg[]) {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    const last = out[out.length - 1];
    // Tool results and the next question are both "user" turns: merge them into one.
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.text || "…" }]);
    else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.text.trim()) blocks.push({ type: "text", text: m.text });
      for (const c of m.calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      if (blocks.length) push("assistant", blocks);
    } else push("user", m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })));
  }
  return out;
}

async function anthropic(t: Target, system: string, messages: Msg[], tools: ToolSpec[], signal: AbortSignal, onText: (d: string) => void): Promise<Completion> {
  const res = await post(
    `${t.base_url || DEFAULT_BASE.anthropic}/v1/messages`,
    { "x-api-key": t.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: t.model,
      max_tokens: MAX_TOKENS,
      // Cache the tools and the prompt: every step of a turn sends the same start again.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: anthropicMessages(messages),
      tools: tools.length ? tools.map((x, i) => (i === tools.length - 1 ? { ...x, cache_control: { type: "ephemeral" } } : x)) : undefined,
      stream: true,
    },
    signal,
  );
  let text = "";
  const calls: (Call & { json: string })[] = [];
  const blocks: Record<number, { kind: "text" } | { kind: "tool"; call: Call & { json: string } }> = {};
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stop: Completion["stop"] = "end";
  for await (const e of sse(res)) {
    if (e.type === "message_start") {
      const u = e.message?.usage ?? {};
      usage.input += u.input_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
    } else if (e.type === "content_block_start") {
      const b = e.content_block;
      if (b?.type === "tool_use") {
        const call = { id: b.id, name: b.name, input: {}, json: "" };
        calls.push(call);
        blocks[e.index] = { kind: "tool", call };
      } else blocks[e.index] = { kind: "text" };
    } else if (e.type === "content_block_delta") {
      const b = blocks[e.index];
      if (e.delta?.type === "text_delta") {
        text += e.delta.text;
        onText(e.delta.text);
      } else if (e.delta?.type === "input_json_delta" && b?.kind === "tool") b.call.json += e.delta.partial_json;
    } else if (e.type === "message_delta") {
      usage.output = e.usage?.output_tokens ?? usage.output;
      const r = e.delta?.stop_reason;
      stop = r === "tool_use" ? "tools" : r === "max_tokens" ? "length" : "end";
    } else if (e.type === "error") throw new ProviderError(502, `The AI provider failed: ${e.error?.message ?? "unknown error"}`);
  }
  return { text, calls: calls.map(({ json, ...c }) => ({ ...c, input: parseArgs(json) })), usage, stop };
}

// ── OpenAI and compatible ───────────────────────────────────────────────────────────────────

function openaiMessages(system: string, messages: Msg[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant")
      out.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.calls.length ? m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) : undefined,
      });
    else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
  }
  return out;
}

async function openai(t: Target, system: string, messages: Msg[], tools: ToolSpec[], signal: AbortSignal, onText: (d: string) => void): Promise<Completion> {
  const res = await post(
    `${t.base_url || DEFAULT_BASE[t.provider]}/chat/completions`,
    { Authorization: `Bearer ${t.apiKey}` },
    {
      model: t.model,
      ...(t.provider === "relaxai" ? { max_tokens: RELAX_MAX_TOKENS } : {}),
      messages: openaiMessages(system, messages),
      tools: tools.length ? tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description, parameters: x.input_schema } })) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    },
    signal,
  );
  let text = "";
  const calls: Record<number, Call & { json: string }> = {};
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stop: Completion["stop"] = "end";
  for await (const e of sse(res)) {
    if (e.error) throw new ProviderError(502, `The AI provider failed: ${e.error.message ?? "unknown error"}`);
    if (e.usage) {
      // prompt_tokens includes any served from OpenAI's cache, which cost a tenth.
      const cached = e.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage.input = (e.usage.prompt_tokens ?? 0) - cached;
      usage.cacheRead = cached;
      usage.output = e.usage.completion_tokens ?? usage.output;
    }
    const ch = e.choices?.[0];
    if (!ch) continue;
    const d = ch.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      onText(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const c = (calls[tc.index ?? 0] ??= { id: tc.id ?? `call_${tc.index ?? 0}`, name: "", input: {}, json: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.json += tc.function.arguments;
    }
    if (ch.finish_reason) stop = ch.finish_reason === "tool_calls" ? "tools" : ch.finish_reason === "length" ? "length" : "end";
  }
  const list = Object.values(calls).map(({ json, ...c }) => ({ ...c, input: parseArgs(json) }));
  return { text, calls: list, usage, stop: list.length ? "tools" : stop };
}

// ── plumbing ────────────────────────────────────────────────────────────────────────────────

function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...headers }, body: JSON.stringify(body), signal, redirect: "error" });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ProviderError(502, `Couldn't reach the AI provider at ${new URL(url).host}`);
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    const j = JSON.parse(text);
    detail = j.error?.message ?? j.message ?? "";
  } catch {
    detail = text.slice(0, 200);
  }
  const why =
    res.status === 401 || res.status === 403
      ? "The provider refused the API key"
      : res.status === 404
        ? "The provider doesn't know that model (or the base URL is wrong)"
        : res.status === 429
          ? "The provider says you're over a rate or spending limit"
          : `The AI provider answered ${res.status}`;
  throw new ProviderError(res.status === 429 ? 429 : 502, detail ? `${why}: ${detail}` : why);
}

/** The JSON events of a server-sent event stream. */
async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // a keep-alive or a line we don't understand
      }
    }
  }
}
