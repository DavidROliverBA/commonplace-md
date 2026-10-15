// Client-side wikilink resolution, mirroring notes.resolveLink on the server: exact path first,
// then title, then a path suffix, then an alias or id; shortest path wins ties.

import { normaliseTarget } from "../../src/markdown";
import type { NoteSummary } from "./api";

/** The note a [[target]] opens, from the list already loaded (no request). */
export function resolveLocal(notes: NoteSummary[], target: string): NoteSummary | undefined {
  const t = normaliseTarget(target);
  if (!t) return undefined;
  let best: NoteSummary | undefined;
  let bestRank = 9;
  for (const n of notes) {
    const p = n.path.replace(/\.md$/i, "").toLowerCase();
    const rank = p === t ? 0 : n.title.toLowerCase() === t ? 1 : p.endsWith("/" + t) ? 2 : n.aliases?.includes(t) ? 3 : 9;
    if (rank < bestRank || (rank === bestRank && rank < 9 && best && n.path.length < best.path.length)) {
      best = n;
      bestRank = rank;
    }
  }
  return bestRank < 9 ? best : undefined;
}

/** Link text to use for a note: bare title unless another note shares it. */
export function linkTextFor(notes: NoteSummary[], note: NoteSummary): string {
  const clash = notes.some((n) => n.id !== note.id && n.title.toLowerCase() === note.title.toLowerCase());
  return clash ? note.path.replace(/\.md$/i, "") : note.title;
}

/** A person's cursor colour, the same on every screen: golden-angle hues, so neighbours differ. */
export function userColor(id: number): { color: string; light: string } {
  const hue = (id * 137.508) % 360;
  return { color: `hsl(${hue} 70% 45%)`, light: `hsl(${hue} 70% 45% / 0.25)` };
}

/** Subsequence fuzzy score for the quick switcher and menus; higher is better. A weak match can
 *  score below zero, so no match is -Infinity (stays -Infinity when a caller adds a bonus). */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - t.length * 0.1 + (idx === 0 || t[idx - 1] === "/" ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -Infinity;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

export function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
