// Saved views on a type page (F16), stored as a Bases (`.base`) file (Types/Person.base) so they
// open in other Markdown editors too. We write and read a small subset of the syntax: a filter on the type, and
// per view its kind (table, cards, list), column order, sort, group and simple "property is
// value" filters. Anything else in the file is ignored when reading.

import YAML from "yaml";

export type ViewKind = "table" | "cards" | "list";
export type Section = "all" | "recent" | "untagged" | "orphans";

export interface View {
  name: string;
  kind: ViewKind;
  /** Property names shown, in order (the title is always first). */
  columns: string[];
  sort: { prop: string; dir: "asc" | "desc" } | null;
  group: string | null;
  /** Only notes whose property equals this. */
  where: { prop: string; value: string }[];
}

const prop = (name: string) => (name === "title" ? "file.name" : `note.${name}`);
const unprop = (p: string) => (p === "file.name" ? "title" : p.replace(/^(note|file)\./, ""));

/** A type's saved views as the YAML of its .base file. */
export function toBase(type: string, views: View[]): string {
  return YAML.stringify({
    filters: { and: [`type == ${JSON.stringify(type)}`] },
    views: views.map((v) => ({
      type: v.kind,
      name: v.name,
      ...(v.where.length ? { filters: { and: v.where.map((w) => `${prop(w.prop)} == ${JSON.stringify(w.value)}`) } } : {}),
      order: ["file.name", ...v.columns.map(prop)],
      ...(v.sort ? { sort: [{ property: prop(v.sort.prop), direction: v.sort.dir.toUpperCase() }] } : {}),
      ...(v.group ? { groupBy: { property: prop(v.group), direction: "ASC" } } : {}),
    })),
  });
}

/** The views in a .base file, skipping any this app can't show; [] for none or bad YAML. */
export function fromBase(yaml: string | null): View[] {
  if (!yaml) return [];
  let doc: any;
  try {
    doc = YAML.parse(yaml);
  } catch {
    return [];
  }
  const out: View[] = [];
  for (const v of Array.isArray(doc?.views) ? doc.views : []) {
    if (!v || typeof v !== "object") continue;
    const kind: ViewKind = v.type === "cards" ? "cards" : v.type === "list" ? "list" : "table";
    const order: string[] = Array.isArray(v.order) ? v.order.map(String).map(unprop) : [];
    const s = Array.isArray(v.sort) ? v.sort[0] : null;
    const where: View["where"] = [];
    for (const f of Array.isArray(v.filters?.and) ? v.filters.and : []) {
      const m = typeof f === "string" ? /^\s*(?:note\.)?([\w-]+)\s*==\s*"(.*)"\s*$/.exec(f) : null;
      if (m && m[1] !== "type") where.push({ prop: m[1]!, value: m[2]! });
    }
    out.push({
      name: typeof v.name === "string" && v.name ? v.name : "View",
      kind,
      columns: order.filter((c) => c !== "title"),
      sort: s?.property ? { prop: unprop(String(s.property)), dir: String(s.direction).toUpperCase() === "DESC" ? "desc" : "asc" } : null,
      group: v.groupBy?.property ? unprop(String(v.groupBy.property)) : null,
      where,
    });
  }
  return out;
}
