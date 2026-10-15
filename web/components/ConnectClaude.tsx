// Settings → Connections → Connect Claude: an MCP token so Claude Code (or another agent) can
// search, read and write your notes (src/mcp.ts, docs/MCP.md).

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/links";
import { Icon } from "../ui/Icon";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { copy, type Token } from "./ShareFromPhone";

export function ConnectClaude() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [name, setName] = useState("Claude Code");
  const [readOnly, setReadOnly] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; row: Token } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<Token[]>("/me/tokens").then((all) => setTokens(all.filter((t) => t.scope.startsWith("mcp"))), toastError);
  useEffect(() => void load(), []);

  async function create() {
    setBusy(true);
    try {
      setFresh(await api<{ token: string; row: Token }>("/me/tokens", { body: { kind: "mcp", name, readOnly } }));
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: Token) {
    if (!(await confirmDialog({ title: `Revoke “${t.name}”?`, message: "Anything using it loses access to your notes at once.", action: "Revoke", danger: true }))) return;
    try {
      await api(`/me/tokens/${t.id}`, { method: "DELETE" });
      if (fresh?.row.id === t.id) setFresh(null);
      await load();
      toast(`Revoked “${t.name}”`);
    } catch (e) {
      toastError(e);
    }
  }

  const url = `${location.origin}/mcp`;
  const command = fresh ? `claude mcp add --transport http commonplace ${url} --header "Authorization: Bearer ${fresh.token}"` : "";

  return (
    <section className="settings-section">
      <h3>Connect Claude</h3>
      <p className="muted">
        Let Claude Code, or another AI agent that speaks MCP, search, read and write your notes as you. It sees every vault you can, with your role in each; its edits merge
        with live typing and are kept in each note's history.
      </p>

      {tokens && tokens.length > 0 && (
        <ul className="members">
          {tokens.map((t) => (
            <li key={t.id}>
              <div>
                <b>{t.name}</b>{" "}
                <span className="muted">
                  · {t.scope === "mcp:read" ? "read only" : "read and write"} · {t.last_used_at ? `last used ${relativeTime(t.last_used_at)}` : "not used yet"}
                </span>
              </div>
              <button className="danger-link" onClick={() => void revoke(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {fresh ? (
        <div className="capture-setup">
          <p className="notice">
            <b>Copy this now</b>: the token is shown only once. Treat it like a password: it can {fresh.row.scope === "mcp:read" ? "read" : "read and change"} your notes.
          </p>
          <div className="copy-row">
            <span className="copy-label">Claude Code</span>
            <code>{command}</code>
            <button className="quiet" onClick={() => void copy(command, "Command")} aria-label="Copy command">
              <Icon name="copy" size={16} /> Copy
            </button>
          </div>
          <ol className="steps">
            <li>
              Run that in a terminal. Then in Claude Code, <code>/mcp</code> shows <i>commonplace</i> as connected.
            </li>
            <li>Ask something like “search my notes for the boiler service and summarise it”.</li>
            <li>
              Other clients: the server is <code>{url}</code> (Streamable HTTP) with the header <code>Authorization: Bearer …</code>; see docs/MCP.md.
            </li>
          </ol>
          <button
            onClick={() => {
              setFresh(null);
              void load();
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code" aria-label="Name for this connection" />
          <label className="check">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read only
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Creating…" : "Create MCP token"}
          </button>
        </form>
      )}
    </section>
  );
}
