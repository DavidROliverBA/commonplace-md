// The Links tab of the side panel, beside an open note: on a daily note its calendar and what was
// made or changed that day; the outline; backlinks (grouped by relation property, F16); outgoing
// links (unresolved ones create the note); unlinked mentions with a one-click Link; and, with
// semantic search on, related notes. Refetched, debounced, when the note's updated_at moves.

import { useEffect, useState } from "react";
import { api, type NoteSummary } from "../lib/api";
import { navigate, noteUrl } from "../lib/router";
import { dailyDate, formatDate, isoDay } from "../lib/templates";
import { typeNamed } from "../lib/types";
import { Icon } from "../ui/Icon";
import { toast, toastError } from "../ui/overlays";
import { DailyCalendar } from "./DailyCalendar";

interface Links {
  /** With the relation property each comes through (F16), empty for a link in the text. */
  backlinks: { id: number; path: string; title: string; type: string | null; properties: string[] }[];
  created_at: string;
  outgoing: { target: string; id: number | null; path: string | null }[];
  related: { id: number; path: string; title: string; similarity: number }[];
}

interface Props {
  vaultId: number;
  /** Viewers see mentions but can't link them. */
  canWrite?: boolean;
  noteId: number;
  notes: NoteSummary[];
  outline: { level: number; text: string; line: number }[];
  jump: (line: number) => void;
  semantic: boolean;
  onCreate: (target: string) => void;
  onNavigate: () => void;
  onDaily: (d: Date) => void;
}

type Item = { id: number; path: string; title: string; type: string | null };

export function RightPanel(p: Props) {
  const [links, setLinks] = useState<Links | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const version = p.notes.find((n) => n.id === p.noteId)?.updated_at;

  useEffect(() => {
    let live = true;
    // Debounced: while someone types, updated_at ticks every few seconds.
    const t = setTimeout(() => {
      api<Links>(`/vaults/${p.vaultId}/notes/${p.noteId}/links`).then(
        (l) => live && (setLinks(l), setLinksError(null)),
        (e) => live && setLinksError(e instanceof Error ? e.message : String(e)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [p.vaultId, p.noteId, version, p.notes.length]);

  const go = (id: number) => {
    navigate(noteUrl(p.vaultId, id));
    p.onNavigate();
  };
  const minLevel = Math.min(...p.outline.map((h) => h.level), 6);
  const path = p.notes.find((n) => n.id === p.noteId)?.path ?? "";
  const day = dailyDate(path);

  // Days thread themselves (F16): a daily note lists what was made and changed that day.
  const [activity, setActivity] = useState<{ made: Item[]; changed: Item[] } | null>(null);
  useEffect(() => {
    setActivity(null);
    if (!day) return;
    let live = true;
    api<{ made: Item[]; changed: Item[] }>(`/vaults/${p.vaultId}/days/${isoDay(day)}`)
      .then((a) => live && setActivity({ made: a.made.filter((n) => n.id !== p.noteId), changed: a.changed.filter((n) => n.id !== p.noteId) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [p.vaultId, p.noteId, day?.getTime(), version]);

  // Mentions of this note's title that aren't links yet, with a one-click Link (after Capacities'
  // "Related content").
  const [unlinked, setUnlinked] = useState<{ id: number; path: string; title: string; snippet: string }[]>([]);
  // Another note: nothing of the last one's stays up while this one's links load.
  useEffect(() => {
    setLinks(null);
    setLinksError(null);
    setUnlinked([]);
  }, [p.vaultId, p.noteId]);
  const loadMentions = (live = () => true) =>
    api<typeof unlinked>(`/vaults/${p.vaultId}/notes/${p.noteId}/mentions`).then(
      (m) => live() && setUnlinked(m),
      () => {},
    );
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => void loadMentions(() => live), 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [p.vaultId, p.noteId, p.notes]);
  const link = async (sourceId: number, title: string) => {
    setUnlinked((m) => m.filter((x) => x.id !== sourceId));
    try {
      await api(`/vaults/${p.vaultId}/notes/${p.noteId}/mentions`, { body: { source: sourceId } });
      toast(`Linked from “${title}”`);
    } catch (e) {
      toastError(e);
      void loadMentions();
    }
  };

  // Backlinks through a relation, grouped by property ("attendees: Kickoff, Review"); the rest
  // are mentions in the text.
  const viaProps = new Map<string, Links["backlinks"]>();
  const mentions: Links["backlinks"] = [];
  for (const b of links?.backlinks ?? []) {
    if (!b.properties.length) mentions.push(b);
    for (const prop of b.properties) viaProps.set(prop, [...(viaProps.get(prop) ?? []), b]);
  }
  const item = (b: { id: number; title: string; type: string | null }) => (
    <li key={b.id}>
      <button onClick={() => go(b.id)}>
        {b.type && <Icon name={typeNamed(b.type)?.icon ?? "shapes"} size={14} />} {b.title}
      </button>
    </li>
  );

  return (
    <div className="links-panel">
      {day && (
        <section>
          <h3>Daily notes</h3>
          <DailyCalendar notes={p.notes} selected={day} onPick={(d) => (p.onDaily(d), p.onNavigate())} />
        </section>
      )}
      {day && activity && (activity.made.length > 0 || activity.changed.length > 0) && (
        <section>
          <h3>This day</h3>
          {activity.made.length > 0 && (
            <>
              <p className="muted">Made</p>
              <ul className="link-list">{activity.made.map(item)}</ul>
            </>
          )}
          {activity.changed.length > 0 && (
            <>
              <p className="muted">Changed</p>
              <ul className="link-list">{activity.changed.map(item)}</ul>
            </>
          )}
        </section>
      )}
      {!day && links?.created_at && (
        <section className="made-on">
          <button className="link" onClick={() => (p.onDaily(new Date(links.created_at)), p.onNavigate())} title="Open that day's note">
            Made {formatDate(new Date(links.created_at), "dddd D MMMM YYYY")}
          </button>
        </section>
      )}
      {linksError && !links && (
        <section>
          <p className="muted" role="status">
            Couldn't load this note's links. {linksError}
          </p>
        </section>
      )}
      <section>
        <h3>Outline</h3>
        {p.outline.length === 0 ? (
          <p className="muted">No headings.</p>
        ) : (
          <ul className="outline">
            {p.outline.map((h, i) => (
              <li key={i} style={{ paddingLeft: (h.level - minLevel) * 12 }}>
                <button onClick={() => (p.jump(h.line), p.onNavigate())}>{h.text}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {[...viaProps].map(([prop, list]) => (
        <section key={prop}>
          <h3>
            As {prop} <span className="count">{list.length}</span>
          </h3>
          <ul className="link-list">{list.map(item)}</ul>
        </section>
      ))}
      <section>
        <h3>{viaProps.size ? "Mentioned in" : "Backlinks"} {links && <span className="count">{mentions.length}</span>}</h3>
        {links && mentions.length === 0 && <p className="muted">{viaProps.size ? "No mentions in the text." : "Nothing links here yet."}</p>}
        <ul className="link-list">{mentions.map(item)}</ul>
      </section>
      <section>
        <h3>Outgoing links {links && <span className="count">{links.outgoing.length}</span>}</h3>
        <ul className="link-list">
          {links?.outgoing.map((o) => (
            <li key={o.target}>
              {o.id ? (
                <button onClick={() => go(o.id!)}>{o.path!.replace(/\.md$/, "")}</button>
              ) : (
                <button className="unresolved" onClick={() => p.onCreate(o.target)} title="Not created yet — click to create">
                  {o.target} <small>+ create</small>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {unlinked.length > 0 && (
        <section>
          <h3>
            Unlinked mentions <span className="count">{unlinked.length}</span>
          </h3>
          <ul className="mention-list">
            {unlinked.map((m) => (
              <li key={m.id}>
                <div className="mention-head">
                  <button className="link" onClick={() => go(m.id)}>
                    {m.title}
                  </button>
                  {p.canWrite !== false && (
                    <button className="quiet mention-link" onClick={() => void link(m.id, m.title)} title={`Make the mention in “${m.title}” a link here`}>
                      <Icon name="link" size={14} /> Link
                    </button>
                  )}
                </div>
                <p className="muted">{m.snippet}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.semantic && (
        <section>
          <h3>Related</h3>
          {links?.related.length === 0 && <p className="muted">Nothing similar yet (embedding may still be running).</p>}
          <ul className="link-list">
            {links?.related.map((r) => (
              <li key={r.id}>
                <button onClick={() => go(r.id)}>
                  {r.title} <small>{Math.round(r.similarity * 100)}%</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
