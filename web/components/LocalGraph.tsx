// The side panel's Graph tab (after Capacities): the open note in the middle and the notes it
// links with, either way round. Show more steps out a link at a time, Show less steps back; it
// follows you from note to note. The graph page's filters (types, daily notes, busy notes) apply
// here too. "Open the full graph" opens the page centred on this note.

import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteSummary } from "../lib/api";
import { canShowMore, graphUrl, loadFilters, shown } from "../lib/graph";
import { navigate, noteUrl } from "../lib/router";
import { Icon } from "../ui/Icon";
import { useGraphData } from "./Graph";
import { type GraphHandle, GraphCanvas } from "./GraphCanvas";

export function LocalGraph({ vaultId, noteId, notes, onNavigate }: { vaultId: number; noteId: number; notes: NoteSummary[]; onNavigate: () => void }) {
  const data = useGraphData(vaultId, notes);
  const [depth, setDepth] = useState(1);
  const canvas = useRef<GraphHandle>(null);
  useEffect(() => setDepth(1), [noteId]);
  const filters = useMemo(() => ({ ...loadFilters(vaultId), orphans: true }), [vaultId, noteId]);
  const view = useMemo(() => (data ? shown(data, { centre: noteId, depth, filters }) : null), [data, noteId, depth, filters]);
  const more = useMemo(() => !!data && canShowMore(data.edges, noteId, depth), [data, noteId, depth]);
  const title = data?.nodes.find((n) => n.id === noteId)?.title ?? "this note";

  return (
    <div className="local-graph">
      <div className="graph-stage">
        {view && (
          <GraphCanvas
            ref={canvas}
            nodes={view.nodes}
            edges={view.edges}
            types={data!.types}
            centre={noteId}
            simplified={filters.simplified}
            compact
            label={`Notes linked with ${title}: ${view.nodes.length - 1}`}
            onOpen={(id) => {
              if (id === noteId) return;
              navigate(noteUrl(vaultId, id));
              onNavigate();
            }}
          />
        )}
        {view && view.nodes.length === 1 && (
          <div className="graph-empty">
            <p>No links to or from {title} yet.</p>
          </div>
        )}
        <div className="graph-bar" role="toolbar" aria-label="Graph">
          <button className="quiet" onClick={() => setDepth(Math.max(1, depth - 1))} disabled={depth <= 1}>
            Show less
          </button>
          <button className="quiet" onClick={() => setDepth(depth + 1)} disabled={!more}>
            Show more
          </button>
          <button className="icon-btn" onClick={() => (navigate(graphUrl(vaultId, { note: noteId })), onNavigate())} aria-label="Open the full graph around this note" title="Open the full graph around this note">
            <Icon name="graph" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
