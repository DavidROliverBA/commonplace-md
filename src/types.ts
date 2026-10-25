// Types (F16, after Capacities: think in things, not files). A type is a note in `Types/`, such as
// `Types/Person.md`. Its frontmatter lists the properties every Person has, plus an icon and a
// colour; its body is the template for new People. A note *is* a Person when its frontmatter says
// `type: Person`. Relations to other types are wikilinks (`company: "[[Acme]]"`), as the
// `.base` format expects, so they're ordinary links too. Everything stays plain markdown.
//
// Shared with the browser: keep it free of server imports.

import YAML from "yaml";

export const TYPES_FOLDER = "Types";

export type PropKind = "text" | "number" | "date" | "checkbox" | "list" | "select" | "relation";
export const PROP_KINDS: PropKind[] = ["text", "number", "date", "checkbox", "list", "select", "relation"];

export interface TypeProp {
  name: string;
  kind: PropKind;
  /** For select: the choices. */
  options?: string[];
  /** For relation: the type it points at ("Person"), or any note when absent. */
  type?: string;
  /** For relation: more than one ("attendees"). */
  many?: boolean;
}

export interface TypeDef {
  name: string;
  /** The type's own note, in Types/. */
  noteId: number;
  path: string;
  icon: string;
  colour: string;
  properties: TypeProp[];
  /** A `[[link]]` to a note of this type on a line of its own shows as a card (F2). */
  cards: boolean;
  /** The date property that places a note on the graph's timeline (`timeline: met`), if the
   *  type names one; otherwise the timeline takes its first date property that isn't a birthday. */
  timeline: string | null;
  /** How many notes are of this type. */
  count: number;
}

/** Colours a type can take, mapped to the design tokens. */
export const TYPE_COLOURS = ["purple", "blue", "green", "amber", "red", "grey"] as const;

/** Is this path a type's definition note? Only directly inside Types/, not deeper. */
export function isTypePath(path: string): boolean {
  return new RegExp(`^${TYPES_FOLDER}/[^/]+\\.md$`, "i").test(path);
}

/** The type a note's frontmatter names, tidied: `type: Person`, `type: "[[Person]]"` or `[Person]`. */
export function typeOf(frontmatter: Record<string, unknown> | null | undefined): string | null {
  let t = frontmatter?.type;
  if (Array.isArray(t)) t = t[0];
  if (typeof t !== "string") return null;
  const name = t.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.trim();
  return name || null;
}

/** A type definition from its note's title and parsed frontmatter. Anything odd is dropped
 *  rather than failing, so a hand-edited type note can never break the app. */
export function readTypeDef(title: string, frontmatter: Record<string, unknown>, meta: { noteId: number; path: string; count: number }): TypeDef {
  const props: TypeProp[] = [];
  const raw = Array.isArray(frontmatter.properties) ? frontmatter.properties : [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || name === "type" || props.some((x) => x.name === name)) continue;
    const kind = PROP_KINDS.includes(o.kind as PropKind) ? (o.kind as PropKind) : "text";
    const prop: TypeProp = { name, kind };
    if (kind === "select") prop.options = Array.isArray(o.options) ? o.options.map(String).filter(Boolean) : [];
    if (kind === "relation") {
      if (typeof o.type === "string" && o.type.trim()) prop.type = o.type.trim();
      prop.many = o.many === true;
    }
    props.push(prop);
  }
  const colour = TYPE_COLOURS.includes(frontmatter.colour as any) ? String(frontmatter.colour) : "purple";
  return { name: title, ...meta, icon: typeof frontmatter.icon === "string" && frontmatter.icon ? frontmatter.icon : "file", colour, properties: props, cards: frontmatter.cards !== false, timeline: typeof frontmatter.timeline === "string" && frontmatter.timeline.trim() ? frontmatter.timeline.trim() : null };
}

/** The markdown for a new, blank type's note: one property to start from, and a heading. */
export function newTypeNote(name: string, icon = "file", colour = "purple"): string {
  return withTypeShape("# {{title}}\n\n", { icon, colour, properties: [{ name: "status", kind: "select", options: ["Active", "Done"] }] });
}

/** A new note of a type: its `type:` line, then the type's template (its note's body). */
export function newTypedNote(type: TypeDef, templateBody: string): string {
  return `---\ntype: ${type.name}\n---\n${templateBody.replace(/^\s+/, "")}`;
}

/** The wikilink targets a property value holds ("[[Sam]]", ["[[Sam]]", "[[Alex]]"]). */
export function linkTargets(value: unknown): string[] {
  const vals = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of vals) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(/\[\[([^\[\]|#\n]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.push(m[1]!.trim());
  }
  return out;
}

// ── editing types ──────────────────────────────────────────────────────────────────────────

/** The part of a type that the type editor changes. */
export interface TypeShape {
  icon: string;
  colour: string;
  properties: TypeProp[];
  /** Links on a line of their own as cards (the default), or plain links. */
  cards?: boolean;
}

/** Icons a type can have (names in web/ui/Icon.tsx). */
export const TYPE_ICONS = ["user", "users", "building", "calendar", "briefcase", "book", "bookmark", "lightbulb", "file", "tag", "link", "image", "check", "sparkle", "graph", "vault"];

const FM_BLOCK = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** A property as written in the type's YAML: only the keys its kind uses. */
function propYaml(p: TypeProp): Record<string, unknown> {
  const o: Record<string, unknown> = { name: p.name, kind: p.kind };
  if (p.kind === "select") o.options = p.options ?? [];
  if (p.kind === "relation") {
    if (p.type) o.type = p.type;
    if (p.many) o.many = true;
  }
  return o;
}

/** A type note's text with its definition replaced: icon, colour and properties change; any other
 *  keys in its frontmatter, and the template below, stay as they were. */
export function withTypeShape(cur: string, shape: TypeShape): string {
  const m = FM_BLOCK.exec(cur);
  const doc = YAML.parseDocument(m ? m[1]! : "");
  if (doc.errors.length || (doc.contents && !YAML.isMap(doc.contents))) throw new Error("This type's YAML doesn't parse; fix it in source mode first");
  doc.set("icon", shape.icon);
  doc.set("colour", shape.colour);
  const list = doc.createNode(shape.properties.map(propYaml));
  // Choices on one line ([Friend, Family]), as people write them by hand.
  YAML.visit(list, { Seq: (key, node, path) => void (path.length > 2 && (node.flow = true)) });
  doc.set("properties", list);
  if (shape.cards === false) doc.set("cards", false);
  else doc.delete("cards");
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${m ? cur.slice(m[0].length) : cur}`;
}

/** Starter types (from Capacities' use cases): add one, or several, in a click. */
export interface Starter {
  name: string;
  about: string;
  shape: TypeShape;
  template: string;
}

const prop = (name: string, kind: PropKind, extra: Partial<TypeProp> = {}): TypeProp => ({ name, kind, ...extra });

export const STARTERS: Starter[] = [
  {
    name: "Person",
    about: "Friends, family, trades and colleagues: who they are and how to reach them.",
    shape: {
      icon: "user",
      colour: "blue",
      properties: [
        prop("role", "select", { options: ["Family", "Friend", "Colleague", "Trade"] }),
        prop("organisation", "relation", { type: "Organisation" }),
        prop("email", "text"),
        prop("phone", "text"),
        prop("birthday", "date"),
      ],
    },
    template: "# {{title}}\n\n## Notes\n",
  },
  {
    name: "Organisation",
    about: "Companies, charities, councils: the places people work and the firms you deal with.",
    shape: {
      icon: "building",
      colour: "grey",
      properties: [prop("kind", "select", { options: ["Company", "Charity", "Public body", "Club"] }), prop("website", "text"), prop("phone", "text")],
    },
    template: "# {{title}}\n\n## Notes\n",
  },
  {
    name: "Meeting",
    about: "What was said and decided, who was there, and what happens next.",
    shape: {
      icon: "calendar",
      colour: "amber",
      properties: [prop("date", "date"), prop("attendees", "relation", { type: "Person", many: true }), prop("project", "relation", { type: "Project" })],
    },
    template: "# {{title}}\n\n## Agenda\n\n## Notes\n\n## Actions\n- [ ] \n",
  },
  {
    name: "Project",
    about: "Something with an end: its status, when it's due and who's involved.",
    shape: {
      icon: "briefcase",
      colour: "purple",
      properties: [
        prop("status", "select", { options: ["Planned", "Active", "On hold", "Done"] }),
        prop("due", "date"),
        prop("people", "relation", { type: "Person", many: true }),
      ],
    },
    template: "# {{title}}\n\n## Goal\n\n## Tasks\n- [ ] \n\n## Notes\n",
  },
  {
    name: "Book",
    about: "What you're reading and have read, with your highlights and rating.",
    shape: {
      icon: "book",
      colour: "green",
      properties: [
        prop("author", "text"),
        prop("status", "select", { options: ["To read", "Reading", "Read"] }),
        prop("rating", "number"),
        prop("finished", "date"),
      ],
    },
    template: "# {{title}}\n\n## Summary\n\n## Highlights\n",
  },
  {
    name: "Weblink",
    about: "A page saved from the web: its address, site and summary, with your notes on it.",
    shape: {
      icon: "link",
      colour: "blue",
      properties: [prop("url", "text"), prop("site", "text"), prop("description", "text"), prop("saved", "date")],
    },
    template: "# {{title}}\n\n## Notes\n",
  },
  {
    name: "Idea",
    about: "A thought worth keeping: where it came from and how far it's got.",
    shape: { icon: "lightbulb", colour: "amber", properties: [prop("stage", "select", { options: ["Seed", "Growing", "Ready"] }), prop("source", "text")] },
    template: "# {{title}}\n\n",
  },
];

/** The note for a starter type. */
export function starterNote(s: Starter): string {
  return withTypeShape(s.template, s.shape);
}

/** The other starter types a starter's relations point at ("Meeting" needs "Person", "Project"). */
export function starterNeeds(s: Starter): string[] {
  return [...new Set(s.shape.properties.filter((p) => p.kind === "relation" && p.type).map((p) => p.type!))].filter((t) => t !== s.name && STARTERS.some((x) => x.name === t));
}
