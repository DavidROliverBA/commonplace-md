// A line diff, + and − with unchanged runs folded (web/lib/diff.ts): an AI assistant's change
// before it's applied, and a GitHub vault's changes against the repo.

import type { DiffLine } from "../lib/diff";

export function Diff({ lines, label = "What changes" }: { lines: DiffLine[]; label?: string }) {
  return (
    <pre className="diff" aria-label={label}>
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          <span key={i} className="diff-gap">
            ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
          </span>
        ) : (
          <span key={i} className={`diff-${l.kind}`}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
            {l.text || " "}
          </span>
        ),
      )}
    </pre>
  );
}
