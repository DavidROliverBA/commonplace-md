// The graph's data (src/graph.ts) and what's shown of it, after Capacities: a scope (a type, a
// folder, a tag or a search), filters (only or hide types, daily notes, busy notes, unlinked
// notes), a neighbourhood around one note that Show more and Show less step through, and the
// timeline's range (F21: each note's date, notes per month, which notes fall outside). Pure, so
// it's unit-tested; the canvas (web/components/GraphCanvas.tsx) only draws what this gives it.

export interface GraphNode {
  id: number;
  title: string;
  path: string;
  type: string | null;
  tags: string[];
  daily: boolean;
  /** When the note is (YYYY-MM-DD), for the timeline: see `noteWhen` in src/graph.ts. */
  when: string;
  whenFrom: "daily" | "property" | "made";
}
export interface GraphEdge {
  source: number;
  target: number;
  /** The property the link comes from (`attendees`), or null for a link in the text. */
  label: string | null;
}
export interface GraphType {
  name: string;
  icon: string;
  colour: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  types: GraphType[];
}

export type Scope = { kind: "type" | "folder" | "tag"; value: string } | { kind: "search"; value: string; ids: number[] } | null;

export interface Filters {
  /** Show only these types ("" is notes without a type); empty shows every type. */
  only: string[];
  /** Hide these types. */
  hide: string[];
  orphans: boolean;
  daily: boolean;
  /** Hide notes with more than BUSY links (hubs that tie everything together). */
  busy: boolean;
  simplified: boolean;
}
export const BUSY = 25;
export const NO_FILTERS: Filters = { only: [], hide: [], orphans: true, daily: true, busy: false, simplified: false };

/** How many filters differ from showing everything: the badge on the Filters button. */
export const activeFilters = (f: Filters) => (f.only.length ? 1 : 0) + (f.hide.length ? 1 : 0) + (f.orphans ? 0 : 1) + (f.daily ? 0 : 1) + (f.busy ? 1 : 0);

export function degrees(edges: GraphEdge[]): Map<number, number> {
  const deg = new Map<number, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

export function inScope(n: GraphNode, scope: Scope): boolean {
  if (!scope) return true;
  switch (scope.kind) {
    case "type":
      return (n.type ?? "").toLowerCase() === scope.value.toLowerCase();
    case "folder":
      return n.path.startsWith(scope.value.replace(/\/+$/, "") + "/");
    case "tag": {
      const t = scope.value.replace(/^#/, "").toLowerCase();
      return n.tags.some((x) => x === t || x.startsWith(t + "/"));
    }
    case "search":
      return scope.ids.includes(n.id);
  }
}

/** Each note's neighbours, built once per list of edges (a hub with thousands of links made
 *  rebuilding it on every render slow). */
const adjacency = new WeakMap<GraphEdge[], Map<number, number[]>>();
function neighboursOf(edges: GraphEdge[]): Map<number, number[]> {
  let next = adjacency.get(edges);
  if (next) return next;
  next = new Map();
  const add = (a: number, b: number) => {
    const list = next!.get(a);
    if (list) list.push(b);
    else next!.set(a, [b]);
  };
  for (const e of edges) (add(e.source, e.target), add(e.target, e.source));
  adjacency.set(edges, next);
  return next;
}

/** The notes within `depth` links of `centre`, either way round. */
export function neighbourhood(edges: GraphEdge[], centre: number, depth: number): Set<number> {
  const next = neighboursOf(edges);
  const seen = new Set([centre]);
  let ring = [centre];
  for (let d = 0; d < depth && ring.length; d++) {
    const out: number[] = [];
    for (const id of ring) for (const m of next.get(id) ?? []) if (!seen.has(m)) (seen.add(m), out.push(m));
    ring = out;
  }
  return seen;
}

/** Whether Show more would add anything at this depth. */
export const canShowMore = (edges: GraphEdge[], centre: number, depth: number) => neighbourhood(edges, centre, depth + 1).size > neighbourhood(edges, centre, depth).size;

export interface Shown {
  nodes: (GraphNode & { deg: number })[];
  edges: GraphEdge[];
  /** Notes the scope and centre allowed before filters, to tell "filtered out" from "nothing here". */
  before: number;
}

/** What to draw: the scope (or the neighbourhood of `centre`), less what the filters hide. The
 *  centre always stays, whatever the filters say. Degrees count every link in the vault, so a
 *  busy note looks busy even when its neighbours are hidden. */
export function shown(d: GraphData, opts: { scope?: Scope; centre?: number | null; depth?: number; filters: Filters }): Shown {
  const { filters: f, centre = null, depth = 1, scope = null } = opts;
  const deg = degrees(d.edges);
  const near = centre !== null ? neighbourhood(d.edges, centre, depth) : null;
  const only = new Set(f.only.map((t) => t.toLowerCase()));
  const hide = new Set(f.hide.map((t) => t.toLowerCase()));
  const base = d.nodes.filter((n) => (near ? near.has(n.id) : inScope(n, scope)));
  const keep = new Set(
    base
      .filter((n) => {
        if (n.id === centre) return true;
        const t = (n.type ?? "").toLowerCase();
        if (only.size && !only.has(t)) return false;
        if (hide.has(t)) return false;
        if (!f.daily && n.daily) return false;
        if (f.busy && (deg.get(n.id) ?? 0) > BUSY) return false;
        return true;
      })
      .map((n) => n.id),
  );
  const edges = d.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  if (!f.orphans) {
    const linked = degrees(edges);
    for (const id of [...keep]) if (id !== centre && !linked.get(id)) keep.delete(id);
  }
  return { nodes: base.filter((n) => keep.has(n.id)).map((n) => ({ ...n, deg: deg.get(n.id) ?? 0 })), edges, before: base.length };
}

// ── the timeline (F21) ────────────────────────────────────────────────────────────

/** A range of days, both ends included (YYYY-MM-DD). */
export interface DayRange {
  from: string;
  to: string;
}
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Days since 1970 for a YYYY-MM-DD, and back: the sliders move in whole days. */
export const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
export const dayFromNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** The same day a month on (or back, with -1), kept within the month's length. */
export function addMonths(d: string, by: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + by, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}

/** The first and last day among these notes, or null with none. */
export function daySpan(nodes: { when: string }[]): DayRange | null {
  if (!nodes.length) return null;
  let from = nodes[0]!.when;
  let to = from;
  for (const n of nodes) (n.when < from && (from = n.when), n.when > to && (to = n.when));
  return { from, to };
}

/** The most bars the strip draws: past that, a bar covers several months (a quarter, a year…). */
export const MAX_BARS = 240;

/** Notes per month from the first month to the last, empty months included: the strip's bars. A
 *  long span groups months, so each bar starts at `month` and covers `months` of them. */
export function perMonth(nodes: { when: string }[], span: DayRange): { month: string; months: number; count: number }[] {
  const index = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  const first = index(span.from);
  const total = index(span.to) - first + 1;
  let step = Math.ceil(total / MAX_BARS);
  if (step > 12) step = Math.ceil(step / 12) * 12; // whole years once a bar is more than a year
  else if (step > 6) step = 12;
  else if (step > 3) step = 6;
  else if (step > 1) step = 3;
  const counts = new Map<number, number>();
  for (const n of nodes) {
    const b = Math.floor((index(n.when) - first) / step);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const out: { month: string; months: number; count: number }[] = [];
  const start = `${span.from.slice(0, 7)}-01`;
  for (let b = 0; b * step < total; b++) out.push({ month: addMonths(start, b * step).slice(0, 7), months: step, count: counts.get(b) ?? 0 });
  return out;
}

/** The notes outside the range (to fade or hide); empty when there's no range. */
export function outside(nodes: { id: number; when: string }[], r: DayRange | null): Set<number> {
  return new Set(r ? nodes.filter((n) => n.when < r.from || n.when > r.to).map((n) => n.id) : []);
}

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
/** A range in words: "4 March 2025", "March to June 2025", "November 2024 to February 2025". */
export function rangeWords(r: DayRange): string {
  if (r.from === r.to) return fmt(r.from, { day: "numeric", month: "long", year: "numeric" });
  const wholeMonths = r.from.endsWith("-01") && dayFromNumber(dayNumber(r.to) + 1).endsWith("-01");
  if (!wholeMonths) {
    const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
    return `${fmt(r.from, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })} to ${fmt(r.to, { day: "numeric", month: "long", year: "numeric" })}`;
  }
  if (r.from.slice(0, 7) === r.to.slice(0, 7)) return fmt(r.from, { month: "long", year: "numeric" });
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmt(r.from, sameYear ? { month: "long" } : { month: "long", year: "numeric" })} to ${fmt(r.to, { month: "long", year: "numeric" })}`;
}

/** The range from the graph page's address (?from=…&to=…), or null. */
export function rangeFrom(search: string): DayRange | null {
  const q = new URLSearchParams(search);
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  return DAY_RE.test(from) && DAY_RE.test(to) && from <= to ? { from, to } : null;
}

/** A scope from the graph page's address (?type=, ?folder=, ?tag=, ?search=); search ids come later. */
export function scopeFrom(search: string): { scope: Scope; note: number | null } {
  const q = new URLSearchParams(search);
  const note = Number(q.get("note")) || null;
  for (const kind of ["type", "folder", "tag"] as const) {
    const v = q.get(kind);
    if (v) return { scope: { kind, value: v }, note };
  }
  const s = q.get("search");
  return { scope: s ? { kind: "search", value: s, ids: [] } : null, note };
}

export const graphUrl = (vaultId: number, p: { type?: string; folder?: string; tag?: string; search?: string; note?: number } = {}) => {
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return `/v/${vaultId}/graph${q.size ? `?${q}` : ""}`;
};

/** Filters are remembered per vault on this device (view state, kept where it acts). */
export function loadFilters(vaultId: number): Filters {
  try {
    return { ...NO_FILTERS, ...JSON.parse(localStorage.getItem(`cp:graph:${vaultId}`) ?? "{}") };
  } catch {
    return NO_FILTERS;
  }
}
export function saveFilters(vaultId: number, f: Filters) {
  try {
    localStorage.setItem(`cp:graph:${vaultId}`, JSON.stringify(f));
  } catch {}
}
