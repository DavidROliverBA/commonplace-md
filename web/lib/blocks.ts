// Blocks for the editor's `+` / `⋮⋮` handle (F12 step 2). A note stays plain markdown: a block is
// worked out from the syntax tree each time, never stored. It's a list item with its children, a
// heading's own line, a paragraph, a table, a code block or a quote (callouts included).
// Everything here is pure (state in, changes out) so it's tested without a browser.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { minimalChange } from "./frontmatter";

export type BlockKind = "item" | "heading" | "paragraph" | "table" | "code" | "quote" | "other";

export interface Block {
  /** Start of its first line and end of its last (no trailing newline). */
  from: number;
  to: number;
  kind: BlockKind;
  /** The first line's indent (a nested list item's). */
  indent: string;
  /** A heading's text, for its [[Note#heading]] link. */
  heading?: string;
}

const KIND: [RegExp, BlockKind][] = [
  [/^(ATX|Setext)Heading/, "heading"],
  [/^Paragraph$/, "paragraph"],
  [/^Table$/, "table"],
  [/^(FencedCode|CodeBlock)$/, "code"],
  [/^Blockquote$/, "quote"],
];

const tree = (state: EditorState, upTo: number) => ensureSyntaxTree(state, upTo, 200) ?? syntaxTree(state);

/** The block on the line at `pos`, or null on a blank line or in the frontmatter. */
export function blockAt(state: EditorState, pos: number): Block | null {
  const line = state.doc.lineAt(pos);
  if (!line.text.trim()) return null;
  const indent = /^\s*/.exec(line.text)![0];
  let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = tree(state, line.to).resolveInner(line.from + indent.length, 1);
  for (let up: typeof node | null = node; up; up = up.parent) if (up.name === "Frontmatter") return null; // its YAML has a Document too
  let found: { from: number; to: number; name: string } | null = null;
  for (; node; node = node.parent) {
    if (node.name === "ListItem") {
      found = node;
      break;
    }
    if (node.parent?.name === "Document" && node.name !== "Document") {
      found = node;
      break;
    }
  }
  if (!found) return null;
  const first = state.doc.lineAt(found.from);
  let last = state.doc.lineAt(Math.max(found.from, found.to - (found.to > found.from && state.doc.sliceString(found.to - 1, found.to) === "\n" ? 1 : 0)));
  // A loose list item can run on over blank lines; the block ends at its last text.
  while (last.number > first.number && !last.text.trim()) last = state.doc.line(last.number - 1);
  const kind = found.name === "ListItem" ? "item" : (KIND.find(([re]) => re.test(found!.name))?.[1] ?? "other");
  const block: Block = { from: first.from, to: last.to, kind, indent: /^\s*/.exec(first.text)![0] };
  if (kind === "heading") block.heading = first.text.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
  return block;
}

const isBlank = (state: EditorState, n: number) => n >= 1 && n <= state.doc.lines && !state.doc.line(n).text.trim();

/** What to delete to take the block out: its lines, a newline, and a blank line it leaves doubled. */
export function removalRange(state: EditorState, b: Block): { from: number; to: number } {
  const doc = state.doc;
  const first = doc.lineAt(b.from).number;
  const last = doc.lineAt(b.to).number;
  if (last < doc.lines) {
    let to = doc.line(last + 1).from;
    // "A\n\nB\n\nC" less B is "A\n\nC", not "A\n\n\nC"; and a block at the top takes its gap.
    if (b.kind !== "item" && isBlank(state, last + 1) && (first === 1 || isBlank(state, first - 1))) to = last + 2 <= doc.lines ? doc.line(last + 2).from : doc.length;
    return { from: b.from, to };
  }
  if (first === 1) return { from: 0, to: doc.length };
  let from = doc.line(first - 1).to;
  if (b.kind !== "item" && isBlank(state, first - 1) && first - 2 >= 1) from = doc.line(first - 2).to;
  return { from, to: b.to };
}

/** Two blocks' gap: list items sit on consecutive lines, anything else has a blank line between. */
const gap = (a: Block, b: Block) => (a.kind === "item" && b.kind === "item" ? "\n" : "\n\n");

function reindent(text: string, from: string, to: string): string {
  if (from === to) return text;
  return text
    .split("\n")
    .map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l))
    .join("\n");
}

/** Text to put `b` (already sliced as `text`) before or after `target`. */
function placed(state: EditorState, b: Block, text: string, target: Block, side: "before" | "after"): ChangeSpec {
  const doc = state.doc;
  // A list item takes the indent of the item it joins; anywhere else it starts at the margin.
  const indent = b.kind === "item" ? (target.kind === "item" ? target.indent : "") : b.indent;
  const body = reindent(text, b.indent, indent);
  const sep = gap(b, target);
  if (side === "before") {
    const prev = doc.lineAt(target.from).number - 1;
    const lead = sep === "\n\n" && prev >= 1 && !isBlank(state, prev) ? "\n" : "";
    return { from: target.from, insert: lead + body + sep };
  }
  const next = doc.lineAt(target.to).number + 1;
  const trail = sep === "\n\n" && next <= doc.lines && !isBlank(state, next) ? "\n" : "";
  return { from: target.to, insert: sep + body + trail };
}

/** Move `b` before or after `target` in one change (so one undo puts it back), or null when it
 *  wouldn't move: onto itself, inside itself, or to where it already is. */
export function moveBlock(state: EditorState, b: Block, target: Block, side: "before" | "after"): ChangeSpec[] | null {
  if (target.from >= b.from && target.to <= b.to) return null;
  const at = side === "before" ? target.from : target.to;
  if (at > b.from && at < b.to) return null;
  const cut = removalRange(state, b);
  const changes = [{ from: cut.from, to: cut.to }, placed(state, b, state.sliceDoc(b.from, b.to), target, side)];
  // Already there (right before the block that follows it, say): nothing to do.
  return state.update({ changes }).state.doc.eq(state.doc) ? null : changes;
}

/** A copy of the block straight after it. */
export function duplicateBlock(state: EditorState, b: Block): ChangeSpec {
  return { from: b.to, insert: gap(b, b) + state.sliceDoc(b.from, b.to) };
}

export type TurnInto = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "numbered" | "todo" | "quote" | "callout";
export const TURN_INTO: { kind: TurnInto; label: string; icon: string }[] = [
  { kind: "paragraph", label: "Text", icon: "text" },
  { kind: "h1", label: "Heading 1", icon: "heading" },
  { kind: "h2", label: "Heading 2", icon: "heading" },
  { kind: "h3", label: "Heading 3", icon: "heading" },
  { kind: "bullet", label: "Bulleted list", icon: "list" },
  { kind: "numbered", label: "Numbered list", icon: "list-ordered" },
  { kind: "todo", label: "To-do", icon: "check" },
  { kind: "quote", label: "Quote", icon: "quote" },
  { kind: "callout", label: "Callout", icon: "callout" },
];
const PREFIX: Partial<Record<TurnInto, string>> = { h1: "# ", h2: "## ", h3: "### ", bullet: "- ", numbered: "1. ", todo: "- [ ] " };
const LINE_PREFIX = /^(\s*)(?:#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/;

/** Which blocks can be turned into something else: text-like ones, not tables or code. */
export const canTurn = (b: Block) => b.kind === "paragraph" || b.kind === "heading" || b.kind === "item" || b.kind === "quote";

/** Turn a block into a paragraph, heading, list item, to-do, quote or callout, as one small change. */
export function turnInto(state: EditorState, b: Block, kind: TurnInto): ChangeSpec | null {
  if (!canTurn(b)) return null;
  const old = state.sliceDoc(b.from, b.to);
  let lines = old.split("\n");
  // Out of whatever it was…
  if (b.kind === "quote") {
    lines = lines.map((l) => l.replace(/^\s*> ?/, ""));
    const callout = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[0]!);
    if (callout) lines = callout[2]!.trim() ? [callout[2]!.trim(), ...lines.slice(1)] : lines.slice(1);
    if (!lines.length) lines = [""];
  } else {
    lines[0] = lines[0]!.replace(LINE_PREFIX, "$1");
  }
  // …and into the new one.
  if (kind === "quote") lines = lines.map((l) => `> ${l}`);
  else if (kind === "callout") lines = ["> [!note]", ...lines.map((l) => `> ${l}`)];
  else if (PREFIX[kind]) lines[0] = lines[0]!.replace(/^(\s*)/, `$1${PREFIX[kind]}`);
  const c = minimalChange(old, lines.join("\n"));
  return c && { from: b.from + c.from, to: b.from + c.to, insert: c.insert };
}
