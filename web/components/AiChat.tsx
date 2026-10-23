// One AI conversation on screen (F13): the `@name` box in a note and the AI side panel are both
// this. Replies stream in; what the assistant did shows as quiet lines ("Searched for boiler: 3
// found"); a change it wants to make outside the open note shows as a card with a diff, to apply
// or discard. Every applied change gets an Undo. The globe turns the web on for this conversation,
// when the assistant is allowed it; a web request waiting to be allowed shows what goes out.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type NoteSummary } from "../lib/api";
import { pounds } from "../../src/prices";
import { type Applied, type Conversation, type Msg, type Pending, tokens, WEB_TOOLS } from "../lib/ai";
import { diffStats, lineDiff } from "../lib/diff";
import { Diff } from "../ui/Diff";
import { renderMarkdown } from "../lib/render";
import { Icon } from "../ui/Icon";
import { toast, toastError } from "../ui/overlays";

interface Props {
  conv: Conversation;
  vaultId: number;
  notes: NoteSummary[];
  onOpenLink: (target: string) => void;
  /** Shown above the messages: the assistant picker in the panel, a title inline. */
  header?: React.ReactNode;
  /** ✓ and ✗: keep the conversation (in the note, or as a note) or throw it away. */
  onKeep?: () => void;
  onDiscard?: () => void;
  keepLabel?: string;
  /** The ✗ button: "Discard" closes the inline box; the panel's starts a new conversation. */
  discard?: { label: string; icon: string };
  placeholder?: string;
  autoFocus?: boolean;
}

export function AiChat(p: Props) {
  const { conv } = p;
  useSyncExternalStore(conv.subscribe, conv.snapshot);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Follow the reply as it streams, unless the person has scrolled up to read.
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useUndoForApplied(conv, p.vaultId);

  const send = () => {
    const t = draft.trim();
    if (!t || conv.busy) return;
    setDraft("");
    stick.current = true;
    void conv.send(t);
  };

  const html = (md: string) => renderMarkdown(md, p.vaultId, p.notes);
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      p.onOpenLink(link.dataset.target!);
    }
  };

  const waiting = conv.pending.filter((x) => !conv.decided.has(x.id));
  const used = conv.usage.input || conv.usage.output;
  const cost = !used ? "" : conv.cost !== null ? `≈ ${pounds(conv.cost)}` : `${tokens(conv.usage.input)} in · ${tokens(conv.usage.output)} out`;
  const t = conv.today;
  const costTitle = [
    `${tokens(conv.usage.input)} tokens in, ${tokens(conv.usage.output)} out this conversation, billed to your key.`,
    t ? `${conv.assistant.name} today: ${pounds(t.spent)}${t.cap !== null ? ` of its ${pounds(t.cap)} limit` : ""}.` : "",
  ].join(" ");
  const nearCap = !!t && t.cap !== null && t.spent >= t.cap * 0.8;

  return (
    <div className="ai-chat" onClick={onClick}>
      {(p.header || p.onKeep || p.onDiscard) && (
        <header className="ai-chat-head">
          <div className="ai-chat-title">{p.header}</div>
          {cost && (
            <span className={`ai-cost${nearCap ? " near-cap" : ""}`} title={costTitle}>
              {cost}
              {nearCap && t ? ` · ${pounds(t.spent)} of ${pounds(t.cap!)} today` : ""}
            </span>
          )}
          {conv.assistant.web && (
            <button
              className={`icon-btn ai-web${conv.web ? " on" : ""}`}
              onClick={() => conv.setWeb(!conv.web)}
              aria-pressed={conv.web}
              aria-label={conv.web ? "The web is on for this conversation: turn it off" : "Let it use the web in this conversation"}
              title={conv.web ? "The web is on: it can search and read pages. Click to turn off." : "The web is off. Click to let it search and read pages."}
            >
              <Icon name="globe" />
            </button>
          )}
          {p.onKeep && (
            <button className="icon-btn" onClick={p.onKeep} disabled={conv.empty || conv.busy} aria-label={p.keepLabel ?? "Keep"} title={p.keepLabel ?? "Keep"}>
              <Icon name="check-plain" />
            </button>
          )}
          {p.onDiscard && (
            <button className="icon-btn" onClick={p.onDiscard} aria-label={p.discard?.label ?? "Discard"} title={p.discard?.label ?? "Discard this conversation"}>
              <Icon name={p.discard?.icon ?? "x"} />
            </button>
          )}
        </header>
      )}
      <div
        className="ai-messages"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        aria-live="polite"
      >
        {conv.empty && !conv.busy && (
          <p className="muted ai-hint">
            Ask {conv.assistant.name} to find, write or tidy: “what do I know about the boiler?”, “make a page from my kitchen notes”, “turn this list into a table”.
          </p>
        )}
        {conv.messages.map((m, i) => (
          <Message key={i} m={m} conv={conv} html={html} />
        ))}
        {conv.live.map((x, i) =>
          x.kind === "text" ? (
            <div key={`l${i}`} className="ai-msg ai-reply markdown" dangerouslySetInnerHTML={{ __html: html(x.text) }} />
          ) : (
            <ToolLineView key={`l${i}`} ok={x.line.ok} summary={x.line.summary} />
          ),
        )}
        {conv.busy && (
          <div className="ai-thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        )}
        {waiting.length > 0 && (
          <div className="ai-pending">
            {waiting.length > 1 && (
              <div className="ai-pending-all">
                <span>{waiting.length} changes to look at</span>
                <button onClick={() => void conv.decideAll(false)}>Discard all</button>
                <button className="primary" onClick={() => void conv.decideAll(true)}>
                  Apply all
                </button>
              </div>
            )}
            {waiting.map((x) => (
              <ChangeCard key={x.id} pending={x} onDecide={(yes) => void conv.decide(x.id, yes)} />
            ))}
          </div>
        )}
        {conv.notice && <p className="notice ai-notice">{conv.notice}</p>}
        {conv.error && (
          <p className="ai-error" role="alert">
            {conv.error}
          </p>
        )}
      </div>
      <form
        className="ai-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          value={draft}
          autoFocus={p.autoFocus}
          rows={1}
          placeholder={p.placeholder ?? `Ask ${conv.assistant.name}…`}
          aria-label={`Message ${conv.assistant.name}`}
          onChange={(e) => {
            setDraft(e.target.value);
            const t = e.currentTarget;
            t.style.height = "auto";
            t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && conv.busy) {
              e.preventDefault();
              conv.stop();
            }
          }}
        />
        {conv.busy ? (
          <button type="button" className="icon-btn" onClick={() => conv.stop()} aria-label="Stop">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="icon-btn send" disabled={!draft.trim()} aria-label="Send">
            <Icon name="send" />
          </button>
        )}
      </form>
    </div>
  );
}

function Message({ m, conv, html }: { m: Msg; conv: Conversation; html: (md: string) => string }) {
  if (m.role === "user") return <div className="ai-msg ai-you">{m.text}</div>;
  if (m.role === "tool") return null;
  return (
    <>
      {m.text.trim() && <div className="ai-msg ai-reply markdown" dangerouslySetInnerHTML={{ __html: html(m.text) }} />}
      {m.calls.map((c) => {
        const line = conv.tools.get(c.id);
        return line ? <ToolLineView key={c.id} ok={line.ok} summary={line.summary} /> : null;
      })}
    </>
  );
}

function ToolLineView({ ok, summary }: { ok: boolean; summary: string }) {
  return (
    <div className={`ai-tool${ok ? "" : " failed"}`}>
      <Icon name={ok ? "check-plain" : "x"} size={14} /> {summary}
    </div>
  );
}

function ChangeCard({ pending, onDecide }: { pending: Pending; onDecide: (yes: boolean) => void }) {
  const pv = pending.preview!;
  const isMove = pending.name === "move_note";
  const isWeb = WEB_TOOLS.has(pending.name);
  const diff = useMemo(() => (isMove || pv.after === null ? null : lineDiff(pv.before ?? "", pv.after)), [pv]);
  const [open, setOpen] = useState(true);
  return (
    <div className="ai-change">
      <div className="ai-change-head">
        <Icon name={isWeb ? "globe" : pv.noteId === null ? "plus" : isMove ? "folder" : "edit"} size={16} />
        <b>{pv.summary}</b>
      </div>
      {isWeb && <p className="muted ai-change-note">It has read from the web in this conversation, so each further web request asks first. Check nothing private is in it.</p>}
      {diff && (
        <>
          <button className="ai-change-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {diffStats(diff)}
            <Icon name="chevron" size={14} />
          </button>
          {open && (
            <Diff lines={diff} />
          )}
        </>
      )}
      <div className="dialog-actions">
        <button onClick={() => onDecide(false)}>{isWeb ? "Don't" : "Discard"}</button>
        <button className="primary" onClick={() => onDecide(true)}>
          {isWeb ? "Allow" : "Apply"}
        </button>
      </div>
    </div>
  );
}

/** Each change the person applies gets a toast with Undo: the old text back, the new note to
 *  Trash, or the note moved back. */
function useUndoForApplied(conv: Conversation, vaultId: number) {
  const seen = useRef(conv.applied.length);
  useEffect(() => {
    const fresh = conv.applied.slice(seen.current);
    seen.current = conv.applied.length;
    for (const a of fresh) {
      // A merge has relinked other notes and sent one to Trash: that's put back from Trash, not here.
      if (a.tool === "merge_notes") toast(`Applied: ${a.preview.summary}. Restore it from Trash if that was wrong.`);
      else toast(`Applied: ${a.preview.summary}`, { undo: () => undo(a, vaultId).catch(toastError) });
    }
  });
}

async function undo(a: Applied, vaultId: number) {
  const pv = a.preview;
  if (a.tool === "move_note" && pv.noteId) {
    await api(`/vaults/${vaultId}/notes/${pv.noteId}`, { method: "PATCH", body: { path: pv.before } });
    return toast("Moved it back");
  }
  if (pv.noteId && pv.before !== null) await api(`/vaults/${vaultId}/notes/${pv.noteId}/content`, { method: "PUT", body: { content: pv.before } });
  if (a.createdId) await api(`/vaults/${vaultId}/notes/${a.createdId}`, { method: "DELETE" });
  toast(a.createdId && !pv.noteId ? "Moved the new note to Trash" : "Put it back as it was");
}
