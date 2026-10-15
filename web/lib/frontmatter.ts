// Editing frontmatter properties as surgical text edits. Each change rewrites only the lines of
// the one property it touches; every other line (comments, quoting, flow lists) stays byte-for-
// byte, so a property edit merges cleanly with whatever collaborators are typing elsewhere.
// Pure functions over the YAML between the `---` lines, so they are unit-tested.

import YAML from "yaml";

export type PropType = "text" | "list" | "number" | "checkbox" | "date";
export type PropValue = string | number | boolean | string[] | null;

export interface Prop {
  key: string;
  type: PropType;
  value: PropValue;
  /** Nested maps, multi-document oddities…: shown as text, edited only as YAML. */
  readOnly: boolean;
}

const OPTS = { lineWidth: 0, nullStr: "", flowCollectionPadding: false } as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The control a value gets in the properties panel, guessed from the value itself. */
export function typeOf(v: unknown): PropType {
  if (Array.isArray(v)) return "list";
  if (typeof v === "boolean") return "checkbox";
  if (typeof v === "number") return "number";
  if (typeof v === "string" && DATE.test(v)) return "date";
  return "text";
}

/** The properties in order, or null if the YAML doesn't parse to a map (edit it as YAML then). */
export function readProps(yaml: string): Prop[] | null {
  let data: unknown;
  try {
    data = yaml.trim() ? YAML.parse(yaml) : {};
  } catch {
    return null;
  }
  if (data === null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) return null;
  return Object.entries(data as Record<string, unknown>).map(([key, v]) => {
    const nested = v !== null && typeof v === "object" && !(Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"));
    const value: PropValue = nested
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? v.filter((x) => x !== null).map(String)
        : v instanceof Date
          ? v.toISOString().slice(0, 10)
          : (v as PropValue) ?? null;
    return { key, type: nested ? "text" : typeOf(value), value, readOnly: nested };
  });
}

// A top-level key line: `key:`, `"key":` or `'key':`, at column 0.
const KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#"'\-?:][^#]*?|-[^\s#][^#]*?))[ \t]*:(?=[ \t]|$)/;

function keyOfLine(line: string): string | null {
  const m = KEY_LINE.exec(line);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/\\(.)/g, "$1");
  if (m[2] !== undefined) return m[2].replace(/''/g, "'");
  return m[3]!.trim();
}

/** The line range [start, end) of a top-level key's entry: its key line plus indented lines. */
function findEntry(lines: string[], key: string): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    if (keyOfLine(lines[i]!) !== key) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end] === "" || /^[ \t]/.test(lines[end]!) || /^-( |$)/.test(lines[end]!))) end++;
    while (end > i + 1 && lines[end - 1]!.trim() === "") end--; // trailing blank lines aren't part of it
    return [i, end];
  }
  return null;
}

function renderEntry(key: string, value: PropValue, flow: boolean): string[] {
  if (Array.isArray(value) && flow) {
    const k = YAML.stringify({ [key]: null }, OPTS).replace(/:\s*$/, "");
    return [`${k}: ${YAML.stringify(value, { ...OPTS, collectionStyle: "flow" }).trimEnd()}`];
  }
  if (Array.isArray(value) && value.length === 0) return [`${YAML.stringify({ [key]: null }, OPTS).trimEnd()}`];
  return YAML.stringify({ [key]: value }, OPTS).trimEnd().split("\n");
}

/** Set (or add, at the end) a property. */
export function setProp(yaml: string, key: string, value: PropValue): string {
  const lines = yaml === "" ? [] : yaml.split("\n");
  const at = findEntry(lines, key);
  if (!at) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, ...renderEntry(key, value, false)].join("\n");
  }
  const line = lines[at[0]]!;
  const flow = /:\s*\[/.test(line);
  const fresh = renderEntry(key, value, flow);
  // Keep the key exactly as written (its quoting); only what follows the colon changes.
  fresh[0] = KEY_LINE.exec(line)![0] + fresh[0]!.slice(KEY_LINE.exec(fresh[0]!)![0].length);
  lines.splice(at[0], at[1] - at[0], ...fresh);
  return lines.join("\n");
}

export function deleteProp(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const at = findEntry(lines, key);
  if (!at) return yaml;
  lines.splice(at[0], at[1] - at[0]);
  return lines.join("\n");
}

/** Rename a property in place, keeping its value text exactly. Throws if `to` already exists. */
export function renameProp(yaml: string, from: string, to: string): string {
  if (from === to) return yaml;
  const lines = yaml.split("\n");
  if (findEntry(lines, to)) throw new Error(`There's already a property called “${to}”`);
  const at = findEntry(lines, from);
  if (!at) return yaml;
  const line = lines[at[0]]!;
  const rest = line.slice(KEY_LINE.exec(line)![0].length);
  lines[at[0]] = YAML.stringify({ [to]: null }, OPTS).replace(/:\s*$/, ":") + rest;
  return lines.join("\n");
}

/** A new property's starting value for its type (a date starts as today). */
export function emptyValue(type: PropType): PropValue {
  return type === "list" ? [] : type === "checkbox" ? false : type === "number" ? 0 : type === "date" ? new Date().toISOString().slice(0, 10) : null;
}

/** The smallest single replacement turning `a` into `b` (for a CRDT-friendly dispatch). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { from: s, to: ea, insert: b.slice(s, eb) };
}
