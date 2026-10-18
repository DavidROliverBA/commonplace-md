// CodeMirror 6 bound to a shared Y.Text: every keystroke is a CRDT update, other people's
// cursors and selections are drawn from awareness, and undo only undoes your own changes.
// On top: Live Preview (web/lib/livePreview.ts) or plain source, autocompletion for [[links]],
// #tags, the `/` menu and `@name` assistants, files pasted or dropped in (photos shrunk, uploaded,
// then embedded), the block handle, and typewriter scrolling for focus mode. NoteView drives it
// through EditorHandle.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, snippet, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  MatchDecorator,
  placeholder,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { findWikiLinks } from "../../src/markdown";
import { cachedAssistants, loadAssistants } from "../lib/ai";
import { type ColourName, stripColour, wrapColour } from "../lib/colours";
import { api, type NoteSummary } from "../lib/api";
import { blockHandle } from "../lib/blockHandle";
import { isOff, offList, unlessOff } from "../lib/debugOff";
import { available, COMMANDS, currentCtx } from "../lib/commands";
import { fuzzyScore, linkTextFor } from "../lib/links";
import { livePreview, refreshLivePreview } from "../lib/livePreview";
import { minimalChange, readProps, setProp } from "../lib/frontmatter";
import { frontmatterYaml, setRelationCandidates } from "../lib/propertiesWidget";
import { subscribeTypes } from "../lib/types";
import { splitTemplate } from "../lib/templates";
import { prepareImage } from "../lib/resizeImage";
import { iconElement } from "../ui/Icon";
import { toast, toastError } from "../ui/overlays";

export interface EditorHandle {
  focus(): void;
  /** Focus with the cursor at the start of the text below any properties, so the properties
   *  panel stays a panel (a cursor inside frontmatter shows it as YAML). */
  focusBody(): void;
  jumpToLine(line: number): void;
  wrap(before: string, after?: string): void;
  insertLinePrefix(prefix: string): void;
  /** Make the cursor's line a heading, list item, to-do or quote, replacing any such prefix. */
  setBlock(prefix: string): void;
  /** Insert at the cursor; with `complete`, open autocompletion after (for [[ and #). */
  insert(text: string, complete?: boolean): void;
  /** The selected text, or (with nothing selected) the cursor's line without its list, to-do or
   *  heading markup, with where it sits; null if that's empty. */
  selectedOrLine(): { text: string; from: number; to: number } | null;
  /** Replace a range, as one undoable change. */
  replaceRange(from: number, to: number, text: string): void;
  /** Upload files (e.g. photos picked on a phone) and embed them at the cursor. */
  insertFiles(files: File[]): void;
  /** Focus "Add property" in the properties panel, creating empty frontmatter if there is none. */
  addProperty(): void;
  /**
   * Insert a filled-in template at the cursor. Its properties join the note's (ones the note
   * already has are kept), so there is never a second frontmatter block.
   */
  insertTemplate(text: string): void;
  /** Insert a CodeMirror snippet (${placeholders}, Tab between them) at the cursor. */
  snippet(template: string): void;
  undo(): void;
  redo(): void;
  /** Where the cursor is. */
  cursor(): number;
  /** Colour the selection (or the word at the cursor): text or highlight, or null to remove (F10). */
  colour(kind: "text" | "highlight", name: ColourName | null): void;
  /** Show `el` (the `@name` chat box) as a block under the line at `pos`, or hide it (null). It
   *  stays with that line as the text around it changes. */
  showInline(pos: number | null, el?: HTMLElement): void;
}

interface Props {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly: boolean;
  /** Live Preview: markdown renders in place except on the cursor's lines. */
  livePreview: boolean;
  vaultId: number;
  notes: () => NoteSummary[];
  /** Changes whenever the note list does (e.g. the array itself), so links re-resolve. */
  notesVersion?: unknown;
  tags: () => string[];
  onOpenLink: (target: string, newNote: boolean) => void;
  /** This note defines a type (F16): its frontmatter is edited in the type editor instead. */
  typeNote?: boolean;
  /** The note being edited, so embeds can't show it inside itself. */
  noteId?: number;
  /** Focus mode: keep the cursor's line in the middle of the screen as you type. */
  typewriter?: boolean;
}

/** Typewriter scrolling: after each move or keystroke, scroll the cursor's line to the middle. */
const typewriterScroll = EditorView.updateListener.of((u) => {
  if (!(u.selectionSet || u.docChanged) || !u.view.hasFocus) return;
  const head = u.state.selection.main.head;
  queueMicrotask(() => u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }));
});

// A line's block markup: heading, list item, to-do or quote (with its indent).
const BLOCK_PREFIX = /^(\s*)((?:#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?)/;

const FM_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// The `@name` chat box sits under its line as a block widget. The element is NoteView's (React
// renders into it), moved into whichever wrapper CodeMirror draws, so it survives redraws.
const setInline = StateEffect.define<{ pos: number; el: HTMLElement } | null>();
class InlineHost extends WidgetType {
  constructor(readonly el: HTMLElement) {
    super();
  }
  eq(o: InlineHost) {
    return o.el === this.el;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-ai-inline";
    wrap.appendChild(this.el);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}
type Inline = { pos: number; el: HTMLElement; deco: ReturnType<typeof Decoration.set> } | null;
const inlineField = StateField.define<Inline>({
  create: () => null,
  update(v, tr) {
    let next: { pos: number; el: HTMLElement } | null = v;
    for (const e of tr.effects) if (e.is(setInline)) next = e.value;
    if (!next) return null;
    if (next === v && !tr.docChanged) return v;
    const pos = next === v ? tr.changes.mapPos(v!.pos, -1) : Math.min(next.pos, tr.state.doc.length);
    const at = tr.state.doc.lineAt(pos).to;
    return { pos, el: next.el, deco: Decoration.set([Decoration.widget({ widget: new InlineHost(next.el), block: true, side: 1 }).range(at)]) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.2em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--faint)" },
]);

const wikiMarks = new MatchDecorator({ regexp: /!?\[\[[^\[\]\n]+?\]\]/g, decoration: Decoration.mark({ class: "cm-wikilink" }) });
const wikiPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = wikiMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = wikiMarks.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);
const tagMarks = new MatchDecorator({ regexp: /(?<=^|\s)#[\p{L}_\-/][\p{L}\p{N}_\-/]*/gu, decoration: Decoration.mark({ class: "cm-tag" }) });
const tagPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = tagMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tagMarks.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function linkAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  for (const l of findWikiLinks(line.text)) {
    if (pos >= line.from + l.from && pos <= line.from + l.to) return l;
  }
  return null;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const roCompartment = useRef(new Compartment());
  const lpCompartment = useRef(new Compartment());
  const twCompartment = useRef(new Compartment());
  const uploadRef = useRef<((view: EditorView, files: File[]) => Promise<void>) | null>(null);
  const lpRef = useRef<ReturnType<typeof livePreview> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    focusBody() {
      const v = viewRef.current;
      // Not before the text has arrived: a cursor parked at 0 would stay inside the properties.
      if (!v || !v.state.doc.length) return;
      const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(v.state.doc.toString());
      if (fm && v.state.selection.main.head === 0) {
        // The end of the first line of text: right where the properties end still counts as
        // touching them, which would show them as YAML.
        const doc = v.state.doc;
        let to = -1;
        for (let n = doc.lineAt(Math.min(fm[0].length, doc.length)).number; n <= doc.lines && to < 0; n++) {
          const line = doc.line(n);
          if (line.from >= fm[0].length && line.text.trim()) to = line.to;
        }
        if (to < 0) return; // only properties: leave them as a panel
        v.dispatch({ selection: { anchor: to } });
      }
      v.focus();
    },
    jumpToLine(line) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
      v.focus();
    },
    wrap(before, after = before) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch(
        v.state.changeByRange((r) => ({
          changes: [
            { from: r.from, insert: before },
            { from: r.to, insert: after },
          ],
          range: EditorSelection.range(r.from + before.length, r.to + before.length),
        })),
      );
      v.focus();
    },
    insertLinePrefix(prefix) {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const has = line.text.startsWith(prefix);
      v.dispatch({ changes: has ? { from: line.from, to: line.from + prefix.length } : { from: line.from, insert: prefix } });
      v.focus();
    },
    setBlock(prefix) {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      // Keep the indent (a nested list item stays nested); swap only the markup after it.
      const [, indent = "", old = ""] = BLOCK_PREFIX.exec(line.text) ?? [];
      const from = line.from + indent.length;
      v.dispatch({ changes: { from, to: from + old.length, insert: prefix }, selection: { anchor: line.to - old.length + prefix.length } });
      v.focus();
    },
    selectedOrLine() {
      const v = viewRef.current;
      if (!v) return null;
      const sel = v.state.selection.main;
      if (!sel.empty) {
        const raw = v.state.sliceDoc(sel.from, sel.to);
        const lead = raw.length - raw.trimStart().length;
        const text = raw.trim();
        return text ? { text, from: sel.from + lead, to: sel.from + lead + text.length } : null;
      }
      const line = v.state.doc.lineAt(sel.head);
      const [prefix = ""] = BLOCK_PREFIX.exec(line.text) ?? [];
      const text = line.text.slice(prefix.length).trim();
      if (!text) return null;
      const from = line.from + prefix.length + (line.text.slice(prefix.length).length - line.text.slice(prefix.length).trimStart().length);
      return { text, from, to: from + text.length };
    },
    replaceRange(from, to, text) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
    insert(text, complete) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
      if (complete) startCompletion(v);
    },
    insertFiles(files) {
      const v = viewRef.current;
      if (v && files.length) void uploadRef.current?.(v, files);
    },
    addProperty() {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      if (frontmatterYaml(v.state.doc.sliceString(0, 200_000)) === null) {
        const fm = "---\n\n---\n";
        v.dispatch({ changes: { from: 0, insert: fm }, selection: { anchor: fm.length } });
      }
      requestAnimationFrame(() => v.dom.querySelector<HTMLInputElement>(".prop-new-key")?.focus());
    },
    insertTemplate(text) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      const { yaml, body } = splitTemplate(text);
      const doc = v.state.doc.toString();
      const head = FM_BLOCK.exec(doc);
      // Body goes at the cursor, but never inside the frontmatter.
      let at = v.state.selection.main.head;
      if (head && at < head[0].length) at = doc.length;
      const changes: { from: number; to?: number; insert: string }[] = [];
      if (yaml !== null && yaml.trim()) {
        if (head) {
          const mine = head[1]!;
          let merged = mine;
          for (const p of readProps(yaml) ?? []) if (!(readProps(merged) ?? []).some((q) => q.key === p.key)) merged = setProp(merged, p.key, p.value);
          const c = minimalChange(mine, merged);
          const start = head[0].indexOf("\n") + 1;
          if (c) changes.push({ from: start + c.from, to: start + c.to, insert: c.insert });
        } else changes.push({ from: 0, insert: `---\n${yaml}\n---\n` });
      }
      const sep = at > 0 && doc[at - 1] !== "\n" ? "\n" : "";
      changes.push({ from: at, insert: sep + body });
      v.dispatch({ changes, scrollIntoView: true, userEvent: "input.template" });
      v.focus();
    },
    snippet(template) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      const { from, to } = v.state.selection.main;
      snippet(template)(v, null, from, to);
      v.focus();
    },
    undo: () => undoRef.current?.undo(),
    redo: () => undoRef.current?.redo(),
    cursor: () => viewRef.current?.state.selection.main.head ?? 0,
    colour(kind, name) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      let { from, to } = v.state.selection.main;
      if (from === to) {
        const w = v.state.wordAt(from);
        if (!w) return void toast("Select some text to colour first");
        ({ from, to } = w);
      }
      // A selection inside coloured text takes the whole coloured run: one colour per run.
      const line = v.state.doc.lineAt(from);
      if (to <= line.to) {
        for (const m of line.text.matchAll(/<(mark|span|font)\b[^>]*>[^<]*<\/\1>|==\{[a-z]+\}[^=\n]*==/gi)) {
          const a = line.from + m.index!;
          const b = a + m[0].length;
          if (a <= from && b >= to && stripColour(m[0]) !== m[0]) {
            from = a;
            to = b;
            break;
          }
        }
      }
      const plain = stripColour(v.state.sliceDoc(from, to));
      const insert = name ? wrapColour(plain, kind, name) : plain;
      const start = name ? from + insert.indexOf(">") + 1 : from;
      v.dispatch({ changes: { from, to, insert }, selection: { anchor: start, head: start + plain.length }, userEvent: "input.colour" });
      v.focus();
    },
    showInline(pos, el) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ effects: [setInline.of(pos === null || !el ? null : { pos, el }), ...(pos === null ? [] : [EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 220 })])] });
    },
  }));

  useEffect(() => {
    const { ytext, awareness } = props;
    const undoManager = new Y.UndoManager(ytext);
    undoRef.current = undoManager;

    const wikilinkCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/!?\[\[[^\]\n]*/);
      if (!m) return null;
      const start = m.text.indexOf("[[") + 2;
      const notes = propsRef.current.notes();
      return {
        from: m.from + start,
        filter: true,
        options: notes.map((n) => {
          const label = linkTextFor(notes, n);
          return {
            label,
            detail: n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined,
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              // closeBrackets may already have inserted "]]" after the cursor.
              const after = view.state.sliceDoc(to, to + 2);
              const insert = after === "]]" ? label : `${label}]]`;
              view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + label.length + 2 } });
            },
          };
        }),
      };
    };
    const tagCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}_\-/]*/u);
      if (!m) return null;
      const from = m.from + m.text.indexOf("#") + 1;
      return { from, options: propsRef.current.tags().map((tag) => ({ label: tag, type: "keyword" })) };
    };

    // Menus that open as you type (/ and @) only in prose: not in code, frontmatter or a URL.
    const inProse = (ctx: CompletionContext, at: number) => {
      const head = FM_BLOCK.exec(ctx.state.doc.sliceString(0, Math.min(ctx.state.doc.length, 200_000)));
      if (head && at < head[0].length) return false;
      for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
        if (/^(FencedCode|CodeBlock|InlineCode|CodeText|HTMLBlock|URL)$/.test(n.name)) return false;
      }
      return true;
    };

    // The `/` menu (web/lib/commands.ts): at the start of a line or after a space ("a/b" and
    // "https://" don't start with a space). A space closes it.
    const slashCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(])\/[\p{L}\p{N}-]*/u);
      if (!m || propsRef.current.readOnly) return null;
      const slash = m.from + m.text.indexOf("/");
      if (!inProse(ctx, slash)) return null;
      const q = ctx.state.sliceDoc(slash + 1, ctx.pos);
      const cmds = available("slash")
        .map((c) => ({ c, s: q ? Math.max(fuzzyScore(q, c.title) + 50, fuzzyScore(q, `${c.title} ${c.keywords ?? ""}`)) : 0 }))
        .filter((x) => x.s > -Infinity)
        .sort((a, b) => b.s - a.s);
      if (!cmds.length) return null;
      return {
        from: slash,
        filter: false,
        options: cmds.map(({ c }, i) => ({
          label: c.title,
          boost: -i,
          type: c.icon,
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            view.dispatch({ changes: { from, to, insert: "" } }); // drop the "/query"
            c.run(currentCtx());
          },
        })),
      };
    };

    // `@name` opens a chat with one of your AI assistants at that line (F13). Only after a space
    // or at the start of a line, so an email address (a@b.com) never does.
    const mentionCompletions = async (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(])@[\p{L}\p{N}]*/u);
      if (!m || propsRef.current.readOnly) return null;
      const at = m.from + m.text.indexOf("@");
      if (!inProse(ctx, at)) return null;
      const list = await loadAssistants().catch(() => cachedAssistants());
      const remove = (view: EditorView, from: number, to: number) => view.dispatch({ changes: { from, to, insert: "" } });
      return {
        from: at,
        filter: true,
        options: [
          ...list.map((a) => ({
            label: `@${a.name}`,
            detail: a.model,
            type: "sparkle",
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              remove(view, from, to);
              currentCtx().note?.askHere(a);
            },
          })),
          {
            label: list.length ? "@ Add an AI assistant…" : "@ Bring your own AI…",
            type: "plus",
            boost: -99,
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              remove(view, from, to);
              currentCtx().app?.addAssistant();
            },
          },
        ],
      };
    };

    const linkTooltip = StateField.define<readonly Tooltip[]>({
      create: (s) => tooltipsFor(s),
      update: (tips, tr) => (tr.docChanged || tr.selection ? tooltipsFor(tr.state) : tips),
      provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
    });
    function tooltipsFor(state: EditorState): readonly Tooltip[] {
      const sel = state.selection.main;
      if (!sel.empty) return [];
      const l = linkAt(state, sel.head);
      if (!l || (l.embed && /\.\w{2,4}$/.test(l.target) && !/\.md$/i.test(l.target))) return [];
      const line = state.doc.lineAt(sel.head);
      return [
        {
          pos: line.from + l.from,
          above: true,
          arrow: false,
          create: () => {
            // CodeMirror styles the tooltip element itself, so the button goes inside it.
            const dom = document.createElement("div");
            dom.className = "cm-open-link-tip";
            const btn = dom.appendChild(document.createElement("button"));
            btn.className = "cm-open-link";
            btn.textContent = `Open ${l.target} ↗`;
            btn.onmousedown = (e) => e.preventDefault();
            btn.onclick = () => propsRef.current.onOpenLink(l.target, false);
            return { dom };
          },
        },
      ];
    }

    const uploadAndInsert = async (view: EditorView, files: File[]) => {
      for (const original of files) {
        const file = await prepareImage(original);
        const form = new FormData();
        const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const name = file.name && file.name !== "image.png" ? file.name : `Pasted image ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.${ext}`;
        form.append("file", file, name);
        try {
          const { path } = await api<{ path: string }>(`/vaults/${propsRef.current.vaultId}/files`, { form });
          view.dispatch(view.state.replaceSelection(`![[${path}]]\n`));
        } catch (err) {
          toastError(err);
        }
      }
    };

    uploadRef.current = uploadAndInsert;

    const lp = livePreview(
      { vaultId: props.vaultId, notes: () => propsRef.current.notes(), typeNote: () => !!propsRef.current.typeNote, noteId: () => propsRef.current.noteId ?? null },
      (target, newNote) => propsRef.current.onOpenLink(target, newNote),
    );

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          roCompartment.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
          unlessOff("keys", keymap.of([...(isOff("brackets") ? [] : closeBracketsKeymap), ...yUndoManagerKeymap, ...(isOff("complete") ? [] : completionKeymap), ...searchKeymap, ...defaultKeymap, indentWithTab])),
          unlessOff("drawsel", drawSelection()),
          unlessOff("drop", dropCursor()),
          unlessOff("indent", indentOnInput()),
          unlessOff("match", bracketMatching()),
          unlessOff("brackets", closeBrackets()),
          unlessOff("select", highlightSelectionMatches()),
          // Without the frontmatter wrapper, lezer reads "key: value\n---" as a setext heading.
          unlessOff("md", yamlFrontmatter({ content: markdown({ base: markdownLanguage, addKeymap: !isOff("mdkeys") }) })),
          syntaxHighlighting(highlight),
          unlessOff("wrap", EditorView.lineWrapping),
          // A name for screen readers (and axe): the text box is the note.
          EditorView.contentAttributes.of({ "aria-label": "Note text" }),
          unlessOff("placeholder", placeholder("Start writing…  / for blocks, [[ links a note, # adds a tag")),
          unlessOff(
            "complete",
            autocompletion({
              override: [wikilinkCompletions, tagCompletions, slashCompletions, mentionCompletions],
              icons: false,
              activateOnTyping: true,
              // The `/` menu's options carry an icon name in `type`; draw it with the app's icons.
              addToOptions: [{ render: (c) => (c.type ? iconElement(c.type) : null), position: 20 }],
            }),
          ),
          unlessOff("wiki", wikiPlugin),
          unlessOff("tag", tagPlugin),
          lpCompartment.current.of(props.livePreview && !isOff("lp") ? lp : []),
          twCompartment.current.of(props.typewriter ? typewriterScroll : []),
          unlessOff("link", linkTooltip),
          unlessOff("field", inlineField),
          unlessOff(
            "handle",
            blockHandle({
              ytext,
              awareness,
              title: () => {
                const notes = propsRef.current.notes();
                const n = notes.find((x) => x.id === propsRef.current.noteId);
                return n ? linkTextFor(notes, n) : null;
              },
              makeTyped: {
                can: () => !!COMMANDS.find((c) => c.id === "note.typed")?.when(currentCtx()),
                run: () => COMMANDS.find((c) => c.id === "note.typed")?.run(currentCtx()),
              },
            }),
          ),
          unlessOff("collab", yCollab(ytext, awareness, { undoManager })),
          EditorView.domEventHandlers({
            mousedown(e, view) {
              if (!(e.metaKey || e.ctrlKey)) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              const l = pos == null ? null : linkAt(view.state, pos);
              if (!l) return false;
              e.preventDefault();
              propsRef.current.onOpenLink(l.target, e.shiftKey);
              return true;
            },
            paste(e, view) {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length || propsRef.current.readOnly) return false;
              e.preventDefault();
              void uploadAndInsert(view, files);
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])];
              if (!files.length || propsRef.current.readOnly) return false;
              e.preventDefault();
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) view.dispatch({ selection: { anchor: pos } });
              void uploadAndInsert(view, files);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (offList().length) toast(`Editor test: ${offList().join(", ")} off`);
    lpRef.current = lp;
    return () => {
      view.destroy();
      undoManager.destroy();
      viewRef.current = null;
    };
  }, [props.ytext, props.awareness]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: roCompartment.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
    });
  }, [props.readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [props.notesVersion]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: twCompartment.current.reconfigure(props.typewriter ? typewriterScroll : []) });
  }, [props.typewriter]);

  // Typed notes' properties panels (F16): redraw when types change; relations pick from notes.
  useEffect(() => {
    setRelationCandidates((type) =>
      propsRef.current
        .notes()
        .filter((n) => !type || (n.type ?? "").toLowerCase() === type.toLowerCase())
        .map((n) => ({ title: n.title, folder: n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined })),
    );
    return subscribeTypes(() => viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) }));
  }, []);

  useEffect(() => {
    if (lpRef.current) viewRef.current?.dispatch({ effects: lpCompartment.current.reconfigure(props.livePreview && !isOff("lp") ? lpRef.current : []) });
  }, [props.livePreview]);

  return <div className={`editor${props.livePreview ? " live-preview" : ""}`} ref={host} />;
});
