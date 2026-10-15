// Settings → AI assistants: the assistants you've added (bring your own AI, F13), to change,
// test or remove. Keys are never shown; only their last four characters.

import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { type Assistant, cachedAssistants, loadAssistants, onAssistants } from "../lib/ai";
import { pounds } from "../../src/prices";
import { relativeTime } from "../lib/links";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { useAssistants } from "./AiPanel";
import { editAssistant } from "./AssistantDialog";

const LABEL = { anthropic: "Anthropic", openai: "OpenAI", relaxai: "relaxAI", compatible: "OpenAI-compatible" } as const;

export function Assistants() {
  const ready = useAssistants();
  const list = useSyncExternalStore(onAssistants, cachedAssistants);

  // The key goes with it and can't come back, so this one asks first.
  async function remove(a: Assistant) {
    if (!(await confirmDialog({ title: `Remove ${a.name}?`, message: "Its API key is deleted from Commonplace. To use it again you'd add it with the key.", action: "Remove", danger: true }))) return;
    try {
      await api(`/me/assistants/${a.id}`, { method: "DELETE" });
      await loadAssistants(true);
      toast(`Removed ${a.name}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function test(a: Assistant) {
    try {
      const r = await api<{ reply: string }>("/me/assistants/test", { body: { id: a.id } });
      toast(`${a.name} works: “${r.reply || "(no reply)"}”`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <section className="settings-section">
      <h3>AI assistants</h3>
      <p className="muted">
        Bring your own AI. Each assistant uses your own API key, which is stored encrypted and never shown again or shared. Type <b>@name</b> in a note, or press ⌘J for the
        side panel.
      </p>
      {ready && list.length > 0 && (
        <ul className="members">
          {list.map((a) => (
            <li key={a.id}>
              <div>
                <b>@{a.name}</b>{" "}
                <span className="muted">
                  · {LABEL[a.provider]} · {a.model} · key …{a.key_hint} · {a.last_used_at ? `used ${relativeTime(a.last_used_at)}` : "not used yet"} ·{" "}
                  {a.daily_cap !== null ? `${pounds(a.spent_today)} of ${pounds(a.daily_cap)} today` : `${pounds(a.spent_today)} today, no limit`}
                </span>
              </div>
              <div className="row">
                <button className="quiet" onClick={() => void test(a)}>
                  Test
                </button>
                <button className="quiet" onClick={() => void editAssistant(a)}>
                  Change
                </button>
                <button className="danger-link" onClick={() => void remove(a)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button className="primary" onClick={() => void editAssistant()}>
        Add an assistant
      </button>
    </section>
  );
}
