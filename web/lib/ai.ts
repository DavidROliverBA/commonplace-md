// The browser half of bring your own AI (F13; the server half is src/ai.ts). A Conversation holds
// one chat: the messages (in the server's neutral shape), the reply streaming in, the changes
// waiting for approval, and what it has cost. The `@name` box in a note and the AI side panel are
// both views of one of these.
//
// The browser also offers the model two tools of its own, to drive the app: open_note, and
// run_app_command over the same command list as the ⌘K palette (so it can only do what you could
// do from there right now).

import { api } from "./api";
import { available, currentCtx } from "./commands";

export type Provider = "anthropic" | "openai" | "relaxai" | "compatible";
export interface Assistant {
  id: number;
  name: string;
  provider: Provider;
  base_url: string;
  model: string;
  key_hint: string;
  last_used_at: string | null;
  /** £ per million tokens (its own, or the list price), or null if unknown. */
  price: { in: number; out: number } | null;
  custom_price: boolean;
  /** £ a day, or null for no limit. */
  daily_cap: number | null;
  spent_today: number;
  /** Allowed to use the web, when a conversation turns it on. */
  web: boolean;
}

/** The tools that reach the web (src/web.ts): approving one sends a request, not a change, so
 *  there's nothing to undo. */
export const WEB_TOOLS = new Set(["web_search", "read_web_page"]);

export interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: Call[] }
  | { role: "tool"; results: { id: string; name: string; content: string; isError?: boolean }[] };

export interface Preview {
  summary: string;
  noteId: number | null;
  path: string;
  before: string | null;
  after: string | null;
}
export interface Pending {
  id: string;
  name: string;
  input: Record<string, unknown>;
  kind: "approve" | "client";
  preview?: Preview;
}
/** What a tool did, as the server described it. */
export interface ToolLine {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  noteId?: number | null;
}
/** A change the person applied, kept so it can be undone. */
export interface Applied {
  tool: string;
  preview: Preview;
  /** A note the change made (create, split), so Undo can send it to Trash. */
  createdId: number | null;
}

// ── assistants ─────────────────────────────────────────────────────────────────────────────

let assistants: Assistant[] = [];
let loaded: Promise<Assistant[]> | null = null;
const assistantListeners = new Set<() => void>();

/** Your assistants, fetched once and shared (force refetches after a change); onAssistants hears
 *  updates. A failed fetch isn't kept, so the next call asks again. */
export function loadAssistants(force = false): Promise<Assistant[]> {
  if (!loaded || force) {
    const p: Promise<Assistant[]> = api<Assistant[]>("/me/assistants").then(
      (list) => {
        assistants = list;
        assistantListeners.forEach((f) => f());
        return list;
      },
      (e) => {
        if (loaded === p) loaded = null;
        throw e;
      },
    );
    loaded = p;
  }
  return loaded;
}
export const cachedAssistants = () => assistants;
export function onAssistants(f: () => void) {
  assistantListeners.add(f);
  return () => void assistantListeners.delete(f);
}

// ── the browser's own tools ───────────────────────────────────────────────────────────────

/** Commands the assistant may run: going places and showing things, nothing that writes. */
function appCommands() {
  return available().filter((c) => (c.group === "Go" || c.group === "View") && c.id !== "view.panel" && !c.href);
}

/** The tools the browser offers the model on top of the server's: open a note, run a read-only command. */
export function clientTools() {
  const cmds = appCommands();
  return [
    {
      name: "open_note",
      description: "Open a note in the app for the person, by path or title.",
      input_schema: { type: "object", properties: { note: { type: "string", description: "Path or title" } }, required: ["note"] },
    },
    {
      name: "run_app_command",
      description: `Run one of the app's commands for the person, e.g. to show the graph, hide the file panel or open today's note. Available now:\n${cmds.map((c) => `- ${c.id}: ${c.title}`).join("\n")}`,
      input_schema: { type: "object", properties: { command: { type: "string", enum: cmds.map((c) => c.id) } }, required: ["command"] },
    },
  ];
}

async function runClientTool(p: Pending): Promise<{ content: string; isError?: boolean }> {
  const app = currentCtx().app;
  if (p.name === "open_note") {
    const opened = app?.openNote(String(p.input.note ?? ""));
    return opened ? { content: `Opened ${opened}` } : { content: `No note “${p.input.note}”`, isError: true };
  }
  if (p.name === "run_app_command") {
    const c = appCommands().find((x) => x.id === p.input.command);
    if (!c) return { content: `That command isn't available right now`, isError: true };
    c.run(currentCtx());
    return { content: `Ran “${c.title}”` };
  }
  return { content: `No tool called ${p.name}`, isError: true };
}

// ── a conversation ─────────────────────────────────────────────────────────────────────────

export type Status = "idle" | "streaming" | "waiting" | "error";

/** Browser tools answered in a row before it stops and lets the person look. */
const MAX_CLIENT_ROUNDS = 6;

export class Conversation {
  messages: Msg[] = [];
  /** The reply as it streams in: text and tool lines, in order. Cleared when the turn ends. */
  live: ({ kind: "text"; text: string } | { kind: "tool"; line: ToolLine })[] = [];
  tools = new Map<string, ToolLine>();
  pending: Pending[] = [];
  decided = new Map<string, boolean>();
  applied: Applied[] = [];
  usage = { input: 0, output: 0 };
  /** £ this conversation has cost, if the model's price is known; today's total and limit. */
  cost: number | null = 0;
  today: { spent: number; cap: number | null } | null = null;
  status: Status = "idle";
  /** The web, on for this conversation (the globe); only if the assistant is allowed it. */
  web = false;
  error = "";
  notice = "";
  private clientDone = new Map<string, { content: string; isError?: boolean }>();
  private abort: AbortController | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    public assistant: Assistant,
    /** Where the person is now: the vault, and the open note if any. */
    private where: () => { vaultId: number; noteId: number | null },
  ) {}

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  /** Turn the web on or off for this conversation; it starts off. */
  setWeb(on: boolean) {
    this.web = on && this.assistant.web;
    this.changed();
  }

  get busy() {
    return this.status === "streaming";
  }
  get empty() {
    return this.messages.length === 0;
  }

  /** Ask something. Pending changes not yet decided are declined first. */
  async send(text: string) {
    if (this.busy || !text.trim()) return;
    const resolved = [...this.pending.map((p) => ({ id: p.id, approve: false })), ...[...this.clientDone].map(([id, result]) => ({ id, result }))];
    this.pending = [];
    this.decided.clear();
    this.clientDone.clear();
    this.messages = [...this.messages, { role: "user", text: text.trim() }];
    await this.turn(resolved, 0);
  }

  /** Decide one pending change; when all are decided, the conversation goes on. */
  async decide(id: string, approve: boolean) {
    this.decided.set(id, approve);
    this.changed();
    if (this.pending.every((p) => this.decided.has(p.id))) {
      const resolved = [
        ...this.pending.map((p) => ({ id: p.id, approve: this.decided.get(p.id)! })),
        ...[...this.clientDone].map(([id, result]) => ({ id, result })),
      ];
      const applying = new Map(this.pending.filter((p) => this.decided.get(p.id)).map((p) => [p.id, p]));
      this.pending = [];
      this.decided.clear();
      this.clientDone.clear();
      await this.turn(resolved, 0, applying);
    }
  }

  async decideAll(approve: boolean) {
    const open = this.pending.filter((p) => !this.decided.has(p.id));
    for (const p of open.slice(0, -1)) this.decided.set(p.id, approve);
    if (open.length) await this.decide(open[open.length - 1]!.id, approve);
  }

  stop() {
    this.abort?.abort();
  }

  private async turn(resolved: { id: string; approve?: boolean; result?: { content: string; isError?: boolean } }[], rounds: number, applying = new Map<string, Pending>()): Promise<void> {
    this.status = "streaming";
    this.error = "";
    this.notice = "";
    this.live = [];
    this.changed();
    const abort = (this.abort = new AbortController());
    const { vaultId, noteId } = this.where();
    let res: Response;
    try {
      res = await fetch("/api/ai/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId: this.assistant.id, vaultId, noteId, messages: this.messages, resolved, clientTools: clientTools(), web: this.web && this.assistant.web }),
        signal: abort.signal,
      });
    } catch {
      return this.fail(abort.signal.aborted ? "" : "Can't reach the server. Check your connection.");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return this.fail(data?.error ?? `The assistant failed (${res.status})`);
    }
    let end: {
      messages: Msg[];
      pending: Pending[];
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
      cost: number | null;
      today: number;
      cap: number | null;
      stopped?: string;
      notice?: string;
    } | null = null;
    try {
      for await (const e of events(res)) {
        if (e.type === "text") {
          const last = this.live[this.live.length - 1];
          if (last?.kind === "text") last.text += e.delta;
          else this.live.push({ kind: "text", text: e.delta });
        } else if (e.type === "tool") {
          const line: ToolLine = { id: e.id, name: e.name, ok: e.ok, summary: e.summary, noteId: e.noteId };
          this.tools.set(e.id, line);
          this.live.push({ kind: "tool", line });
          const p = applying.get(e.id);
          if (p && e.ok && !WEB_TOOLS.has(p.name)) this.applied.push({ tool: p.name, preview: p.preview!, createdId: e.noteId ?? null });
        } else if (e.type === "end") end = e;
        else if (e.type === "error") return this.fail(e.message);
        this.changed();
      }
    } catch {
      if (abort.signal.aborted) return this.fail("");
      return this.fail("The connection dropped before the assistant finished.");
    }
    if (!end) return this.fail(abort.signal.aborted ? "" : "The assistant stopped without finishing.");
    this.messages = end.messages;
    const u = end.usage;
    this.usage = { input: this.usage.input + u.input + u.cacheRead + u.cacheWrite, output: this.usage.output + u.output };
    this.cost = end.cost === null || this.cost === null ? null : this.cost + end.cost;
    this.today = { spent: end.today, cap: end.cap };
    this.live = [];
    this.pending = end.pending;
    if (end.stopped === "steps") this.notice = "It stopped after a dozen steps, to keep the cost down. Say “go on” to let it continue.";
    if (end.stopped === "length") this.notice = "The reply hit the length limit and was cut short.";
    if (end.stopped === "cap") this.notice = end.notice ?? "It reached its daily limit.";
    const client = this.pending.filter((p) => p.kind === "client");
    if (client.length && !this.pending.some((p) => p.kind === "approve")) {
      if (rounds >= MAX_CLIENT_ROUNDS) {
        this.pending = [];
        this.status = "idle";
        this.notice = "It kept driving the app, so it was stopped.";
        return this.changed();
      }
      const results = [];
      for (const p of client) results.push({ id: p.id, result: await runClientTool(p) });
      this.pending = [];
      return this.turn(results, rounds + 1);
    }
    // Browser tools mixed with changes to approve: run the browser ones now, answer with the rest.
    for (const p of client) this.clientDone.set(p.id, await runClientTool(p));
    this.pending = this.pending.filter((p) => p.kind === "approve");
    this.status = this.pending.length ? "waiting" : "idle";
    this.changed();
  }
  private fail(message: string) {
    this.status = message ? "error" : "idle";
    this.error = message;
    this.live = [];
    this.changed();
  }

  /** The conversation as markdown, for saving: "**You:** …" then "**Name:** …". */
  transcript(you: string): string {
    const parts: string[] = [];
    for (const m of this.messages) {
      if (m.role === "user") parts.push(`**${you}:** ${m.text}`);
      else if (m.role === "assistant" && m.text.trim()) {
        const prev = parts[parts.length - 1];
        if (prev?.startsWith(`**${this.assistant.name}:**`)) parts[parts.length - 1] = `${prev}\n\n${m.text.trim()}`;
        else parts.push(`**${this.assistant.name}:** ${m.text.trim()}`);
      }
    }
    return parts.join("\n\n");
  }
}

/** The JSON events of the chat response. */
async function* events(res: Response): AsyncGenerator<any> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith("data: ")) yield JSON.parse(block.slice(6));
    }
  }
}

/** A conversation saved into a note, as a folded callout that opens anywhere markdown does. */
export function asCallout(c: Conversation, you: string, date: string): string {
  const body = c.transcript(you).split("\n").map((l) => (l ? `> ${l}` : ">"));
  return [`> [!ai]- ${c.assistant.name}, ${date}`, ...body].join("\n") + "\n";
}

/** Roughly how many tokens, for the cost line: "3.2k in · 410 out". */
export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
