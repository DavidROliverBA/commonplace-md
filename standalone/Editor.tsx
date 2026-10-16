// The editor for one file: the app's CodeMirror setup (Live Preview, wikilink and tag marks,
// [[ completion) without the live collaboration, which needs the server. Plain undo history
// stands in for the shared one.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, drawSelection, dropCursor, EditorView, keymap, MatchDecorator, placeholder, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { findWikiLinks } from "../src/markdown";
import type { NoteSummary } from "../web/lib/api";
import { fuzzyScore, linkTextFor } from "../web/lib/links";
import { livePreview } from "../web/lib/livePreview";
import { toastError } from "../web/ui/overlays";
import { addAttachment, VAULT_ID } from "./vault";

// The app's heading and inline styles (web/components/Editor.tsx).
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

function marks(regexp: RegExp, cls: string) {
  const m = new MatchDecorator({ regexp, decoration: Decoration.mark({ class: cls }) });
  return ViewPlugin.fromClass(
    class {
      decorations;
      constructor(view: EditorView) {
        this.decorations = m.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = m.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
const wikiPlugin = marks(/!?\[\[[^\[\]\n]+?\]\]/g, "cm-wikilink");
const tagPlugin = marks(/(?<=^|\s)#[\p{L}_\-/][\p{L}\p{N}_\-/]*/gu, "cm-tag");

export interface EditorHandle {
  focus(): void;
  jumpToLine(line: number): void;
}

interface Props {
  /** Which note: the editor starts afresh when it changes. */
  noteId: number;
  initial: string;
  livePreview: boolean;
  notes: () => NoteSummary[];
  onChange: (text: string) => void;
  onOpenLink: (target: string) => void;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lpCompartment = useRef(new Compartment());
  const lpRef = useRef<ReturnType<typeof livePreview> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    jumpToLine(line) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
      v.focus();
    },
  }));

  useEffect(() => {
    const wikilinks = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/\[\[[^\[\]\n|]*/);
      if (!m) return null;
      const q = m.text.slice(2);
      const notes = propsRef.current.notes();
      const options = notes
        .map((n) => ({ n, s: q ? Math.max(fuzzyScore(q, n.title) + 50, fuzzyScore(q, n.path)) : 0 }))
        .filter((x) => x.s > -Infinity)
        .sort((a, b) => b.s - a.s || b.n.updated_at.localeCompare(a.n.updated_at))
        .slice(0, 40)
        .map(({ n }) => ({ label: linkTextFor(notes, n), detail: n.path.includes("/") ? n.path.replace(/\/[^/]*$/, "") : undefined, apply: linkTextFor(notes, n) + "]]" }));
      return { from: m.from + 2, options, filter: false };
    };

    const insertFiles = async (view: EditorView, files: File[]) => {
      for (const f of files) {
        try {
          const path = await addAttachment(f);
          view.dispatch(view.state.replaceSelection(`![[${path}]]\n`));
        } catch (e) {
          toastError(e);
        }
      }
    };

    const lp = livePreview({ vaultId: VAULT_ID, notes: () => propsRef.current.notes(), noteId: () => propsRef.current.noteId }, (target) => propsRef.current.onOpenLink(target));
    lpRef.current = lp;

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          history(),
          keymap.of([...closeBracketsKeymap, ...historyKeymap, ...completionKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          yamlFrontmatter({ content: markdown({ base: markdownLanguage, addKeymap: true }) }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Note text" }),
          placeholder("Start writing…  [[ links a note, # adds a tag"),
          autocompletion({ override: [wikilinks], icons: false, activateOnTyping: true }),
          wikiPlugin,
          tagPlugin,
          lpCompartment.current.of(props.livePreview ? lp : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) propsRef.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            // ⌘-click a [[link]] in Source mode opens it, as in the app.
            mousedown(e, view) {
              if (!(e.metaKey || e.ctrlKey)) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos == null) return false;
              const line = view.state.doc.lineAt(pos);
              const hit = findWikiLinks(line.text).find((l) => pos - line.from >= l.from && pos - line.from <= l.to);
              if (!hit) return false;
              e.preventDefault();
              propsRef.current.onOpenLink(hit.target);
              return true;
            },
            paste(e, view) {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              void insertFiles(view, files);
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])];
              if (!files.length) return false;
              e.preventDefault();
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) view.dispatch({ selection: { anchor: pos } });
              void insertFiles(view, files);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [props.noteId]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lpCompartment.current.reconfigure(props.livePreview && lpRef.current ? lpRef.current : []) });
  }, [props.livePreview]);

  return <div className={`editor${props.livePreview ? " live-preview" : ""}`} ref={host} />;
});
