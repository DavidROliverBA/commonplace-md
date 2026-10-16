// Live Preview for CodeMirror: markdown renders in place as you type. Syntax
// (#, **, [[ ]], link URLs, > , - [ ]) is hidden everywhere except on the lines the cursor or
// selection touches, so editing a line shows its source and leaving it shows the result.
// Inline replacements stay within one line (a ViewPlugin). Frontmatter and tables span lines, so
// they are block widgets, which CodeMirror only accepts from a StateField.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { findWikiLinks, isAttachmentPath } from "../../src/markdown";
import type { NoteSummary } from "./api";
import { resolveLocal } from "./links";
import { readProps } from "./frontmatter";
import { frontmatterYaml, PropertiesWidget } from "./propertiesWidget";
import { drawDiagrams } from "./mermaid";
import { fileUrl, renderMarkdown } from "./render";
import { colourOf, hiloColour } from "./colours";
import { type EmbedCtx, fillCard, fillEmbed } from "./embeds";
import { TableEditWidget } from "./tableWidget";

/** One table cell's markdown as HTML (the paragraph wrapper removed). */
function inlineHtml(md: string, cfg: LivePreviewConfig): string {
  if (!md.trim()) return "";
  return renderMarkdown(md, cfg.vaultId, cfg.notes()).trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}
import { typeNamed } from "./types";

export interface LivePreviewConfig {
  vaultId: number;
  notes: () => NoteSummary[];
  /** A type's own note (F16): its definition is edited in the type editor above, so the
   *  frontmatter shows as one quiet line here instead of a second, rawer form. */
  typeNote?: () => boolean;
  /** The open note, so an embed of it (directly or through others) isn't shown again (F2). */
  noteId?: () => number | null;
}

/** `![[Note]]` on its own line (F2), or a card for a typed note's `[[link]]` on its own line. */
class NoteBlockWidget extends WidgetType {
  constructor(
    readonly kind: "embed" | "card",
    readonly target: string,
    /** Changes when the linked note does, so the widget redraws. */
    readonly version: string,
    readonly ctx: () => EmbedCtx,
  ) {
    super();
  }
  eq(o: NoteBlockWidget) {
    return o.kind === this.kind && o.target === this.target && o.version === this.version;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = `cm-lp-block cm-lp-${this.kind} markdown`;
    if (this.kind === "embed") void fillEmbed(div, this.target, this.ctx());
    else {
      div.classList.add("link-card");
      void fillCard(div, this.target, this.ctx());
    }
    // A click outside its links shows the line's source, as tables and callouts do.
    div.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      const pos = view.posAtDOM(div);
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(pos + 2, view.state.doc.length) } });
    });
    return div;
  }
  ignoreEvent() {
    return true;
  }
}

class TypeDefLine extends WidgetType {
  constructor(readonly onEditYaml: (view: EditorView) => void) {
    super();
  }
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-lp-block cm-type-def-line";
    div.append("Its properties, icon and colour are set in the form above. ");
    const b = div.appendChild(document.createElement("button"));
    b.type = "button";
    b.className = "props-yaml";
    b.textContent = "Edit YAML";
    b.onclick = () => this.onEditYaml(view);
    return div;
  }
  ignoreEvent() {
    return true;
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;
const hide = Decoration.replace({});

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width && o.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    if (this.width) img.width = Number(this.width);
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", "Done");
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = "•";
    return s;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-hr";
    return s;
  }
}

/** Line numbers the selection touches: those show raw markdown. */
function activeLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  if (!focused) return lines;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView, cfg: LivePreviewConfig): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state, view.hasFocus);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  // Ranges the inline regex passes must leave alone: code, and anything already replaced.
  const claimed: [number, number][] = [];
  const free = (from: number, to: number) => !claimed.some(([a, b]) => from < b && to > a);
  const lineDeco = (pos: number, cls: string, attrs?: Record<string, string>) =>
    decos.push(Decoration.line({ class: cls, attributes: attrs }).range(doc.lineAt(pos).from));

  for (const { from, to } of view.visibleRanges) {
    // Wikilinks first: lezer reads the inner "[x]" of "[[x]]" as a shortcut link.
    const wikis: { from: number; to: number; l: ReturnType<typeof findWikiLinks>[number] }[] = [];
    for (let pos = doc.lineAt(from).from; pos <= to; ) {
      const line = doc.lineAt(pos);
      for (const l of findWikiLinks(line.text)) wikis.push({ from: line.from + l.from, to: line.from + l.to, l });
      pos = line.to + 1;
    }
    const inWiki = (a: number, b: number) => wikis.some((w) => a < w.to && b > w.from);

    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const n = node.node;

        if (name === "FencedCode" || name === "CodeBlock") {
          claimed.push([node.from, node.to]);
          for (let pos = node.from; pos <= node.to; ) {
            const line = doc.lineAt(pos);
            const fence = /^\s*(```|~~~)/.test(line.text) && name === "FencedCode";
            lineDeco(pos, fence ? "cm-lp-codeblock cm-lp-fence" : "cm-lp-codeblock");
            pos = line.to + 1;
          }
          return false;
        }
        if (name === "InlineCode") {
          claimed.push([node.from, node.to]);
          decos.push(Decoration.mark({ class: "cm-lp-code" }).range(node.from, node.to));
          if (!isActive(node.from)) {
            for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "CodeMark") decos.push(hide.range(c.from, c.to));
          }
          return false;
        }
        if (name === "FrontMatter" || name === "Frontmatter") return false;

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          lineDeco(node.from, `cm-lp-h cm-lp-h${heading[1]}`);
          return;
        }
        if (name === "HeaderMark") {
          if (n.parent?.name.startsWith("ATXHeading") && !isActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            decos.push(hide.range(node.from, end));
          }
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          if (!isActive(node.from)) decos.push(hide.range(node.from, node.to));
          return;
        }

        if (name === "Link" || name === "Image") {
          if (inWiki(node.from, node.to)) return false;
          const url = n.getChild("URL");
          if (!url) return; // shortcut "[x]": not a link, leave as text
          const href = doc.sliceString(url.from, url.to);
          const marks = n.getChildren("LinkMark");
          if (name === "Image") {
            if (isActive(node.from)) return false;
            const alt = marks.length >= 2 ? doc.sliceString(marks[0]!.to, marks[1]!.from) : "";
            const src = /^([a-z]+:|\/\/)/i.test(href) ? href : fileUrl(cfg.vaultId, safeDecode(href));
            decos.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
            claimed.push([node.from, node.to]);
            return false;
          }
          if (isActive(node.from) || marks.length < 2) return;
          const textFrom = marks[0]!.to;
          const textTo = marks[1]!.from;
          decos.push(hide.range(node.from, textFrom));
          decos.push(hide.range(textTo, node.to));
          const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
          const attrs: Record<string, string> = external ? { "data-href": href } : { "data-target": safeDecode(href) };
          if (textTo > textFrom) decos.push(Decoration.mark({ class: "cm-lp-link", attributes: attrs }).range(textFrom, textTo));
          claimed.push([node.from, node.to]);
          return;
        }
        if (name === "URL" && n.parent?.name !== "Link" && n.parent?.name !== "Image" && n.parent?.name !== "Autolink") {
          const href = doc.sliceString(node.from, node.to);
          if (/^https?:/i.test(href)) decos.push(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } }).range(node.from, node.to));
          return;
        }

        if (name === "Blockquote") {
          const first = doc.lineAt(node.from);
          const callout = /^\s*>\s*\[!([\w-]+)\][+-]?\s*(.*)$/.exec(first.text);
          for (let pos = node.from; pos <= node.to; ) {
            const line = doc.lineAt(pos);
            const cls = callout ? `cm-lp-quote cm-lp-callout${line.from === first.from ? " cm-lp-callout-title" : ""}` : "cm-lp-quote";
            lineDeco(pos, cls, callout ? { "data-callout": callout[1]!.toLowerCase() } : undefined);
            pos = line.to + 1;
          }
          if (callout && !isActive(first.from)) {
            const m = /\[![\w-]+\][+-]?\s*/.exec(first.text)!;
            const start = first.from + m.index;
            // "[!tip]" alone becomes the title "Tip", as in reading view.
            if (!callout[2]) {
              const t = callout[1]!;
              decos.push(Decoration.replace({ widget: new TextWidget(t[0]!.toUpperCase() + t.slice(1)) }).range(start, start + m[0].length));
            } else decos.push(hide.range(start, start + m[0].length));
            claimed.push([start, start + m[0].length]);
          }
          return;
        }
        if (name === "QuoteMark") {
          if (!isActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            decos.push(hide.range(node.from, end));
          }
          return;
        }

        if (name === "ListMark") {
          const item = n.parent;
          const task = item?.getChild("Task")?.getChild("TaskMarker");
          if (task) {
            const checked = /x/i.test(doc.sliceString(task.from, task.to));
            if (checked) lineDeco(node.from, "cm-lp-done");
            if (!isActive(node.from)) {
              const end = doc.sliceString(task.to, task.to + 1) === " " ? task.to + 1 : task.to;
              decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, end));
              claimed.push([node.from, end]);
            }
            return;
          }
          if (/^[-*+]$/.test(doc.sliceString(node.from, node.to)) && !isActive(node.from)) {
            decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
          return;
        }
        if (name === "TaskMarker") return;

        if (name === "HorizontalRule") {
          if (!isActive(node.from)) decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
      },
    });

    for (const w of wikis) {
      if (!free(w.from, w.to)) continue;
      claimed.push([w.from, w.to]);
      const { l } = w;
      if (isActive(w.from)) continue;
      const path = l.target.split("#")[0]!;
      if (l.embed && isAttachmentPath(path) && IMAGE.test(path)) {
        const size = /^(\d+)(?:x\d+)?$/.exec(l.alias ?? "");
        decos.push(Decoration.replace({ widget: new ImageWidget(fileUrl(cfg.vaultId, path), path, size?.[1]) }).range(w.from, w.to));
        continue;
      }
      const raw = doc.sliceString(w.from, w.to);
      const open = raw.startsWith("!") ? 3 : 2;
      const pipe = raw.indexOf("|");
      const labelFrom = w.from + (pipe >= 0 ? pipe + 1 : open);
      const labelTo = w.to - 2;
      if (labelTo <= labelFrom) continue;
      const resolved = isAttachmentPath(path) || !!resolveLocal(cfg.notes(), l.target);
      decos.push(hide.range(w.from, labelFrom));
      decos.push(Decoration.mark({ class: `cm-lp-link cm-lp-wikilink${resolved ? "" : " cm-lp-unresolved"}`, attributes: { "data-target": l.target } }).range(labelFrom, labelTo));
      decos.push(hide.range(labelTo, w.to));
    }

    // ==highlight==, and Hilo's =={red}coloured highlight== (F10)
    for (let pos = doc.lineAt(from).from; pos <= to; ) {
      const line = doc.lineAt(pos);
      for (const m of line.text.matchAll(/==(?=\S)([^=\n]+?)==/g)) {
        const a = line.from + m.index!;
        const b = a + m[0].length;
        if (!free(a, b)) continue;
        const hilo = hiloColour(m[1]!);
        const open = hilo ? 2 + m[1]!.length - hilo.text.length : 2;
        decos.push(Decoration.mark({ class: hilo ? `cm-lp-highlight cm-lp-colour hl-${hilo.name}` : "cm-lp-highlight" }).range(a, b));
        if (!active.has(line.number)) {
          decos.push(hide.range(a, a + open));
          decos.push(hide.range(b - 2, b));
        }
      }
      // Colour tags: <mark style="background: …">, <span style="color: …">, <font color="…">
      for (const m of line.text.matchAll(/<(mark|span|font)\b([^>]*)>([^<]*)<\/\1>/gi)) {
        const a = line.from + m.index!;
        const b = a + m[0].length;
        if (!free(a, b) || !m[3]) continue;
        const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(m[2]!)?.slice(1).find((x) => x !== undefined) ?? null;
        const { classes, style } = colourOf(m[1]!, { style: attr("style"), color: attr("color"), class: attr("class") });
        if (!classes.length && !style) continue;
        const openEnd = a + m[0].indexOf(">") + 1;
        const closeStart = b - m[1]!.length - 3;
        claimed.push([a, b]);
        decos.push(Decoration.mark({ class: ["cm-lp-colour", ...classes].join(" "), attributes: style ? { style } : undefined }).range(openEnd, closeStart));
        if (!active.has(line.number)) {
          decos.push(hide.range(a, openEnd));
          decos.push(hide.range(closeStart, b));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}


// ── Block widgets: frontmatter → properties table, GFM tables → rendered tables ───────────────

const setFocus = StateEffect.define<boolean>();

/** Dispatch when the vault's note list changes, so [[links]] re-resolve (and lose "unresolved"). */
export const refreshLivePreview = StateEffect.define<null>();
const refreshed = (u: { transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }) =>
  u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLivePreview)));

/** Rendered HTML for a multi-line block; a click inside reveals its source (or follows a link). */
class BlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly html: string,
    readonly kind: "properties" | "table",
    readonly onOpenLink: (target: string, newNote: boolean) => void,
  ) {
    super();
  }
  eq(o: BlockWidget) {
    return o.html === this.html;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = `cm-lp-block cm-lp-${this.kind} markdown`;
    div.innerHTML = this.html; // sanitised by renderMarkdown (DOMPurify)
    div.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
      if (a) {
        e.preventDefault();
        if (a.dataset.target) this.onOpenLink(a.dataset.target, false);
      }
    });
    div.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return; // external links open natively
      e.preventDefault();
      const pos = view.posAtDOM(div);
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(pos + (this.kind === "properties" ? 4 : 0), view.state.doc.length) } });
    });
    return div;
  }
  ignoreEvent() {
    return true;
  }
}

/** A ```mermaid block, drawn; a click on it (outside a linked node) shows its source. */
class DiagramWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly onOpenLink: (target: string, newNote: boolean) => void,
  ) {
    super();
  }
  eq(o: DiagramWidget) {
    return o.html === this.html;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-lp-block cm-lp-diagram markdown";
    div.innerHTML = this.html; // sanitised by renderMarkdown (DOMPurify)
    div.addEventListener("cp-diagram", () => view.requestMeasure());
    drawDiagrams(div, (t) => this.onOpenLink(t, false));
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(div);
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.lineAt(pos).to, view.state.doc.length) } });
    });
    return div;
  }
  ignoreEvent() {
    return true;
  }
}

/** "Edit YAML": put the cursor on the first property line, which reveals the frontmatter. */
function editYaml(view: EditorView) {
  view.focus();
  view.dispatch({ selection: { anchor: Math.min(view.state.doc.line(Math.min(2, view.state.doc.lines)).from, view.state.doc.length) }, scrollIntoView: true });
}

function blockDecorations(state: EditorState, cfg: BlockConfig, focused: boolean): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const touched = (from: number, to: number) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Frontmatter") {
        if (touched(node.from, node.to)) return false;
        const src = state.doc.sliceString(node.from, node.to);
        const yaml = frontmatterYaml(src + "\n");
        if (yaml !== null && cfg.typeNote?.()) {
          decos.push(Decoration.replace({ widget: new TypeDefLine(editYaml), block: true }).range(node.from, node.to));
        } else if (yaml !== null && readProps(yaml)) {
          decos.push(Decoration.replace({ widget: new PropertiesWidget(yaml, state.readOnly, editYaml), block: true }).range(node.from, node.to));
        } else {
          // YAML that doesn't parse to a map: show what renders, click to fix it as text.
          const html = renderMarkdown(src + "\n", cfg.vaultId, cfg.notes());
          if (html.includes("<table")) decos.push(Decoration.replace({ widget: new BlockWidget(src, html, "properties", cfg.onOpenLink), block: true }).range(node.from, node.to));
        }
        return false;
      }
      if (node.name === "Table") {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        if (touched(from, to)) return false;
        const src = state.doc.sliceString(from, to);
        // Editable cell by cell (F8); a read-only note shows the rendered table.
        const widget = state.readOnly
          ? new BlockWidget(src, renderMarkdown(src, cfg.vaultId, cfg.notes()), "table", cfg.onOpenLink)
          : new TableEditWidget(src, (md) => inlineHtml(md, cfg), (t) => cfg.onOpenLink(t, false));
        decos.push(Decoration.replace({ widget, block: true }).range(from, to));
        return false;
      }
      // A line that is only ![[Note]] shows the note; only [[Typed note]], its card (F2).
      if (node.name === "Paragraph") {
        const line = state.doc.lineAt(node.from);
        if (line.to < node.to) return false;
        const m = /^\s*(!?)\[\[([^\[\]|\n]+?)(?:\|[^\]\n]*)?\]\]\s*$/.exec(line.text);
        if (!m || touched(line.from, line.to)) return false;
        const embed = m[1] === "!";
        const target = m[2]!.trim();
        if (embed && isAttachmentPath(target.split("#")[0]!)) return false;
        const hit = resolveLocal(cfg.notes(), target.split("#")[0]!);
        if (!embed && !(hit && typeNamed(hit.type)?.cards)) return false;
        const ctx = (): EmbedCtx => ({ vaultId: cfg.vaultId, notes: cfg.notes(), ancestors: [cfg.noteId?.() ?? -1], onOpen: (t) => cfg.onOpenLink(t, false) });
        decos.push(Decoration.replace({ widget: new NoteBlockWidget(embed ? "embed" : "card", target, `${hit?.id}:${hit?.updated_at}:${hit?.type}`, ctx), block: true }).range(line.from, line.to));
        return false;
      }
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        if (!info || state.doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid") return false;
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        if (touched(from, to)) return false;
        const src = state.doc.sliceString(from, to);
        decos.push(Decoration.replace({ widget: new DiagramWidget(renderMarkdown(src, cfg.vaultId, []), cfg.onOpenLink), block: true }).range(from, to));
        return false;
      }
      // Tables and frontmatter are blocks; skip walking inline content.
      if (node.name === "Paragraph" || node.name === "FencedCode" || node.name === "CodeBlock" || node.name.startsWith("ATXHeading")) return false;
    },
  });
  return Decoration.set(decos, true);
}

type BlockConfig = LivePreviewConfig & { onOpenLink: (target: string, newNote: boolean) => void };

function blockField(cfg: BlockConfig) {
  const focus = StateField.define<boolean>({
    create: () => false,
    update: (v, tr) => tr.effects.reduce((f, e) => (e.is(setFocus) ? e.value : f), v),
  });
  const blocks = StateField.define<DecorationSet>({
    create: (s) => blockDecorations(s, cfg, false),
    update(deco, tr) {
      const focusChanged = tr.effects.some((e) => e.is(setFocus) || e.is(refreshLivePreview));
      const roChanged = tr.state.readOnly !== tr.startState.readOnly;
      if (tr.docChanged || tr.selection || focusChanged || roChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return blockDecorations(tr.state, cfg, tr.state.field(focus));
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [focus, blocks, EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing))];
}

class TextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: TextWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.textContent = this.text;
    return s;
  }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The Live Preview extension for the editor: the inline ViewPlugin, the block StateField and their
 *  click handling (links, tasks). */
export function livePreview(cfg: LivePreviewConfig, onOpenLink: (target: string, newNote: boolean) => void) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, cfg);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || refreshed(u) || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, cfg);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target as HTMLElement;
      if (el instanceof HTMLInputElement && el.classList.contains("cm-lp-task")) {
        // Flip "[ ]" ↔ "[x]" in the source; the widget re-renders from the new text.
        e.preventDefault();
        if (view.state.readOnly) return true;
        const pos = view.posAtDOM(el);
        const line = view.state.doc.lineAt(pos);
        const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line.text);
        if (m) view.dispatch({ changes: { from: line.from + m[1]!.length, to: line.from + m[1]!.length + 1, insert: m[2] === " " ? "x" : " " } });
        return true;
      }
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
      const link = el.closest<HTMLElement>(".cm-lp-link");
      if (!link) return false;
      e.preventDefault();
      if (link.dataset.href) window.open(link.dataset.href, "_blank", "noopener,noreferrer");
      else if (link.dataset.target) onOpenLink(link.dataset.target, false);
      return true;
    },
  });

  return [plugin, blockField({ ...cfg, onOpenLink }), clicks];
}
