// /boyai, "bring your own AI": add or change an assistant (a name, a provider, a model and your
// own API key). Opened from the / menu, ⌘K and Settings → AI assistants; editAssistant() resolves
// with the saved assistant, or null if cancelled. The key goes to the server once and never comes
// back: editing shows only its last four characters.

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { type Assistant, loadAssistants, type Provider } from "../lib/ai";
import { listPrice } from "../../src/prices";
import { Modal } from "../ui/Modal";
import { toast, toastError } from "../ui/overlays";

/** The name a new assistant starts with, per provider, until you type your own. */
const DEFAULT_NAME: Record<Provider, string> = { anthropic: "Claude", openai: "GPT", relaxai: "Relax", compatible: "Assistant" };

const PROVIDERS: { id: Provider; label: string; models: string[]; keyHelp: string }[] = [
  { id: "anthropic", label: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"], keyHelp: "console.anthropic.com → API keys" },
  { id: "openai", label: "OpenAI", models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"], keyHelp: "platform.openai.com → API keys" },
  {
    id: "relaxai",
    label: "relaxAI",
    models: ["DeepSeek-V4-Pro", "Nemotron-3-Super", "DeepSeek-V41-Flash"],
    keyHelp: "relax.ai → API keys. UK company and datacentre (Civo), billed in £. DeepSeek-V4-Pro writes best; Nemotron-3-Super costs about a fifth.",
  },
  { id: "compatible", label: "Other", models: [], keyHelp: "OpenRouter, a self-hosted model, or any OpenAI-compatible API" },
];

type Open = { existing: Assistant | null; done: (a: Assistant | null) => void };
let open: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** Open the dialog: add an assistant, or change `existing`. */
export function editAssistant(existing: Assistant | null = null): Promise<Assistant | null> {
  return new Promise((done) => {
    open = { existing, done };
    emit();
  });
}

/** Mounted once in App; draws the dialog editAssistant() opened. */
export function AssistantDialogHost() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  if (!open) return null;
  const current = open;
  const close = (a: Assistant | null) => {
    open = null;
    emit();
    current.done(a);
  };
  return <AssistantDialog key={current.existing?.id ?? "new"} existing={current.existing} onClose={close} />;
}

function AssistantDialog({ existing, onClose }: { existing: Assistant | null; onClose: (a: Assistant | null) => void }) {
  const [name, setName] = useState(existing?.name ?? "Claude");
  const [provider, setProvider] = useState<Provider>(existing?.provider ?? "anthropic");
  const [model, setModel] = useState(existing?.model ?? "claude-opus-5-5");
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  // Money: a daily £ limit (£1 unless changed; empty for none), and the price it's counted at:
  // the list price for known models, or your own.
  const [cap, setCap] = useState(existing ? (existing.daily_cap === null ? "" : existing.daily_cap.toFixed(2)) : "1.00");
  const [ownPrice, setOwnPrice] = useState<{ in: string; out: string } | null>(existing?.custom_price && existing.price ? { in: String(existing.price.in), out: String(existing.price.out) } : null);
  const [tested, setTested] = useState<string | null>(null);
  const [web, setWeb] = useState(existing?.web ?? false);
  const p = PROVIDERS.find((x) => x.id === provider)!;

  const pick = (id: Provider) => {
    if (!existing && Object.values(DEFAULT_NAME).includes(name)) setName(DEFAULT_NAME[id]);
    setProvider(id);
    const next = PROVIDERS.find((x) => x.id === id)!;
    if (!next.models.includes(model)) setModel(next.models[0] ?? "");
    setTested(null);
  };

  const list = listPrice(provider, model);
  const shownPrice = ownPrice ?? (list ? { in: String(list.in), out: String(list.out) } : { in: "", out: "" });
  const editPrice = (k: "in" | "out", v: string) => setOwnPrice({ ...shownPrice, [k]: v });
  const priceOf = () => {
    if (!ownPrice) return null;
    const p = { in: Number(ownPrice.in), out: Number(ownPrice.out) };
    if (ownPrice.in.trim() === "" || ownPrice.out.trim() === "") return null;
    return list && p.in === list.in && p.out === list.out ? null : p;
  };

  const draft = () => ({
    name,
    provider,
    model,
    baseUrl: provider === "compatible" ? baseUrl : "",
    apiKey,
    price: priceOf(),
    dailyCap: cap.trim() === "" ? null : Number(cap),
    web,
  });

  async function test() {
    setBusy("test");
    setTested(null);
    try {
      // A saved assistant with no new key is tested with its stored key.
      const r = await api<{ reply: string }>("/me/assistants/test", { body: existing && !apiKey ? { id: existing.id } : { draft: draft() } });
      setTested(`It works. ${name} said: “${r.reply || "(nothing)"}”`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setBusy("save");
    try {
      const a = existing
        ? await api<Assistant>(`/me/assistants/${existing.id}`, { method: "PATCH", body: draft() })
        : await api<Assistant>("/me/assistants", { body: draft() });
      await loadAssistants(true);
      toast(existing ? `Saved ${a.name}` : `Added ${a.name}. Type @${a.name} in a note, or press ⌘J.`);
      onClose(a);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal title={existing ? `${existing.name} settings` : "Bring your own AI"} onClose={() => onClose(null)}>
      <form
        className="assistant-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!existing && <p className="muted">Add an assistant with your own API key. Then type <b>@{name || "name"}</b> in a note to talk to it there, or open the AI panel with ⌘J.</p>}
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value.replace(/[^\p{L}\p{N}]/gu, ""))} maxLength={30} required aria-describedby="name-help" />
          <small id="name-help" className="muted">
            Letters and digits; you'll type @{name || "name"}.
          </small>
        </label>
        <div className="field">
          <span className="field-label">Provider</span>
          <div className="segmented wide" role="radiogroup" aria-label="Provider">
            {PROVIDERS.map((x) => (
              <button type="button" key={x.id} role="radio" aria-checked={provider === x.id} className={provider === x.id ? "on" : ""} onClick={() => pick(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
        {provider === "compatible" && (
          <label className="field">
            <span className="field-label">Base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" inputMode="url" required />
            <small className="muted">The server calls this, so a model on your own Mac needs a public https address.</small>
          </label>
        )}
        <label className="field">
          <span className="field-label">Model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} list="ai-models" placeholder={provider === "compatible" ? "anthropic/claude-opus-5-5" : ""} required />
          <datalist id="ai-models">
            {p.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="field">
          <span className="field-label">Daily limit</span>
          <div className="money-row">
            <span>£</span>
            <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="none" aria-label="Daily limit in pounds" />
            <span className="muted">a day. It stops for the day when it gets there; leave empty for no limit.</span>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Price per million tokens</span>
          <div className="money-row">
            <span>£</span>
            <input value={shownPrice.in} onChange={(e) => editPrice("in", e.target.value)} inputMode="decimal" aria-label="Price per million input tokens, in pounds" />
            <span>in · £</span>
            <input value={shownPrice.out} onChange={(e) => editPrice("out", e.target.value)} inputMode="decimal" aria-label="Price per million output tokens, in pounds" />
            <span>out</span>
          </div>
          <small className="muted">
            {ownPrice && (priceOf() || !list)
              ? "Your own price."
              : list
                ? `${p.label === "Other" ? "The" : `${p.label}'s`} list price (checked 11 Oct 2026${p.id === "relaxai" ? "" : ", converted from $"}). Change it if it has changed.`
                : "Enter the model's price so the cost and the daily limit can be worked out."}
          </small>
        </div>
        <div className="field">
          <span className="field-label">The web</span>
          <label className="check">
            <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> {name || "It"} may search the web and read pages
          </label>
          <small className="muted">
            Off until you allow it. Then the globe in a conversation turns it on for that conversation. After its first web request, it asks before each further one and before any change. Searching needs a Brave Search key (Settings → AI assistants); reading pages doesn't.
          </small>
        </div>
        <label className="field">
          <span className="field-label">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => (setApiKey(e.target.value), setTested(null))}
            placeholder={existing ? `Saved, ends in …${existing.key_hint}. Paste a new one to replace it.` : "Paste your key"}
            autoComplete="off"
            required={!existing}
          />
          <small className="muted">{p.keyHelp}</small>
        </label>
        <p className="notice">
          Your key is stored encrypted and is never shown again, or shared with anyone in your vaults. When you use {name || "it"}, the open note and whatever it reads are sent to{" "}
          {p.label === "Other" ? "that provider" : p.id === "relaxai" ? "relaxAI, in its UK datacentre" : p.label}, under your key and their terms.
        </p>
        {tested && <p className="ok">{tested}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={() => void test()} disabled={!!busy || (!apiKey && !existing)}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <button type="submit" className="primary" disabled={!!busy}>
            {busy === "save" ? "Saving…" : existing ? "Save" : `Add ${name || "assistant"}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
