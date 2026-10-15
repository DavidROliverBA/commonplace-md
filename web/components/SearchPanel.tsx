// The sidebar's Search tab: keyword search, plus semantic (by meaning) when the server has an
// embeddings provider (src/search.ts). Debounced as you type; a later query's reply always wins
// over an earlier one's. The query lives in App, so it survives switching tabs, and can be saved
// to the sidebar as a smart folder (web/lib/savedSearches.ts). Snippets are sanitised down to <mark>.

import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { api, type Session } from "../lib/api";
import { navigate, noteUrl } from "../lib/router";
import { removeSearch, saveSearch, useSavedSearches } from "../lib/savedSearches";
import { Icon } from "../ui/Icon";

interface Hit {
  id: number;
  path: string;
  title: string;
  snippet: string;
  via: string[];
}

export function SearchPanel({ vaultId, session, query, setQuery, onNavigate }: { vaultId: number; session: Session; query: string; setQuery: (q: string) => void; onNavigate: () => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [semantic, setSemantic] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const { list } = useSavedSearches();
  const saved = list.find((s) => s.query === query.trim()) ?? null;

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api<{ hits: Hit[]; semantic: boolean }>(`/vaults/${vaultId}/search?q=${encodeURIComponent(q)}`);
        if (mine === seq.current) {
          setHits(r.hits);
          setSemantic(r.semantic);
        }
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query, vaultId]);

  return (
    <div className="search-panel">
      <input
        ref={input}
        type="search"
        placeholder="Search words, meaning, tag:x, path:x"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        enterKeyHint="search"
      />
      <div className="search-meta muted">
        <span>
          {busy ? "Searching…" : hits ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : session.search.semantic ? `Keyword + semantic (${session.search.provider})` : "Keyword search"}
          {hits && semantic && !busy && " · incl. semantic"}
        </span>
        {query.trim() && (
          <button
            className={`quiet search-save${saved ? " on" : ""}`}
            aria-pressed={!!saved}
            title={saved ? "Remove from the sidebar" : "Keep this search in the sidebar"}
            onClick={() => (saved ? removeSearch(vaultId, saved) : saveSearch(vaultId, query))}
          >
            <Icon name="bookmark" size={14} /> {saved ? "Saved" : "Save"}
          </button>
        )}
      </div>
      <ul className="search-results">
        {hits?.map((h) => (
          <li key={h.id}>
            <a
              href={noteUrl(vaultId, h.id)}
              onClick={(e) => {
                e.preventDefault();
                navigate(noteUrl(vaultId, h.id));
                onNavigate();
              }}
            >
              <div className="hit-title">
                {h.title}
                {h.via.includes("semantic") && !h.via.includes("keyword") && !h.via.includes("title") && (
                  <span className="pill" title="Matched by meaning, not exact words">
                    similar
                  </span>
                )}
              </div>
              {h.path.includes("/") && <div className="hit-path">{h.path.replace(/\/[^/]+$/, "")}</div>}
              {h.snippet && <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(h.snippet, { ALLOWED_TAGS: ["mark"] }) }} />}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
