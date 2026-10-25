// The graph (after Capacities): every note with its type, tags and whether it's a daily note, and
// every link between notes. A link that comes from a property (`attendees: [[Sam]]`) carries the
// property's name as its label, so the graph says why two notes are joined. The vault's types
// come too, for their icons and colours. Each note has a date for the timeline (F21), from the
// note itself where it says one, since imported notes were all "made" on the day of the import.
// The browser does the rest: centring, depth, filters, the timeline's range.

import { sql } from "./db";
import { findWikiLinks, normaliseTarget } from "./markdown";
import { linkKeys } from "./notes";
import { settings } from "./settings";
import { listTypes } from "./typeIndex";

/** Properties that aren't relations, even when they hold a link. */
const NOT_RELATIONS = new Set(["type", "tags", "tag", "aliases", "alias", "id", "cssclasses"]);
const DAILY = /^Daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** Properties that say when a note is, in the order they're looked for. */
const DATE_KEYS = ["date", "created", "day"];
/** Date properties that say something about a note's subject, not when the note is. */
const NOT_WHEN = /^(birthday|born|died|anniversary|dob|date of birth)$/i;
const DAY = /^(\d{4}-\d{2}-\d{2})/;

/** A real calendar day from year 1000 on: not 2025-13-01 or 2025-02-30, nor a 0001-01-01
 *  placeholder, which would stretch the timeline across two thousand years. */
const realDay = (d: string) => d >= "1000" && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const isReal = (d: string) => {
  try {
    return realDay(d);
  } catch {
    return false; // Invalid Date
  }
};

/** The day a property's value names ("2025-03-04", or the start of "2025-03-04T09:30"), or null. */
const dayIn = (v: unknown) => {
  const d = typeof v === "string" ? (DAY.exec(v.trim())?.[1] ?? null) : null;
  return d && isReal(d) ? d : null;
};

/** When a note is, for the timeline: a daily note's day, else a date property (date, created, day,
 *  then the type's own: the one it names with `timeline:`, or its first date property that isn't a
 *  birthday), else the day it was made here. */
export function noteWhen(n: { path: string; frontmatter: Record<string, unknown>; made: string }, typeDateProp: string | null): { when: string; whenFrom: "daily" | "property" | "made" } {
  const daily = DAILY.test(n.path) ? /(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)![1]! : null;
  if (daily && isReal(daily)) return { when: daily, whenFrom: "daily" };
  const fm = Object.fromEntries(Object.entries(n.frontmatter ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of [...DATE_KEYS, ...(typeDateProp ? [typeDateProp.toLowerCase()] : [])]) {
    const d = dayIn(fm[k]);
    if (d) return { when: d, whenFrom: "property" };
  }
  return { when: n.made, whenFrom: "made" };
}

/** Link targets in a property's value (a string, or a list of them), normalised as links are. */
function targetsIn(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value];
  return parts.filter((v): v is string => typeof v === "string").flatMap((v) => findWikiLinks(v).map((l) => normaliseTarget(l.target)));
}

export async function graph(vaultId: number) {
  const rows = await sql<{ id: number; title: string; path: string; type: string | null; tags: string[]; frontmatter: Record<string, unknown>; made: string }[]>`
    select id, title, path, type_name as type, tags, frontmatter,
           to_char(created_at at time zone ${settings.timeZone}, 'YYYY-MM-DD') as made
    from notes where vault_id = ${vaultId}`;
  // Which property each source note links a target through: "source key" → property names.
  const via = new Map<string, string[]>();
  for (const r of rows) {
    for (const [prop, value] of Object.entries(r.frontmatter ?? {})) {
      if (NOT_RELATIONS.has(prop.toLowerCase())) continue;
      for (const t of targetsIn(value)) {
        const k = `${r.id} ${t}`;
        const names = via.get(k) ?? [];
        if (!names.includes(prop)) via.set(k, [...names, prop]);
      }
    }
  }
  const links = await sql<{ source: number; target: number; key: string }[]>`
    with k as (${linkKeys(vaultId)})
    select distinct l.source_id as source, k.id as target, l.target as key
    from links l join k on k.k = l.target
    where l.vault_id = ${vaultId} and l.source_id <> k.id`;
  const edges = new Map<string, { source: number; target: number; label: string | null }>();
  for (const l of links) {
    const id = `${l.source} ${l.target}`;
    const label = via.get(`${l.source} ${l.key}`)?.sort().join(", ") ?? null; // jsonb keeps no order: alphabetical
    const had = edges.get(id);
    if (!had || (!had.label && label)) edges.set(id, { source: Number(l.source), target: Number(l.target), label });
  }
  const { types } = await listTypes(vaultId);
  const datePropOf = new Map(types.map((t) => [t.name.toLowerCase(), t.timeline ?? t.properties.find((p) => p.kind === "date" && !NOT_WHEN.test(p.name))?.name ?? null]));
  return {
    nodes: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      path: r.path,
      type: r.type,
      tags: r.tags,
      daily: DAILY.test(r.path),
      ...noteWhen(r, datePropOf.get((r.type ?? "").toLowerCase()) ?? null),
    })),
    edges: [...edges.values()],
    types: types.map((t) => ({ name: t.name, icon: t.icon, colour: t.colour })),
  };
}
