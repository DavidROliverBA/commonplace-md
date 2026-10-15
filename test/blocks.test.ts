// Block operations behind the editor's block handle (F12, web/lib/blocks.ts): finding the block
// at a position, moving, deleting, duplicating and "turn into". Pure CodeMirror state, no
// browser or database needed.

import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorState } from "@codemirror/state";
import { blockAt, duplicateBlock, moveBlock, removalRange, turnInto } from "../web/lib/blocks";

const state = (doc: string) => EditorState.create({ doc, extensions: [yamlFrontmatter({ content: markdown({ base: markdownLanguage }) })] });
const at = (s: EditorState, text: string) => blockAt(s, s.doc.toString().indexOf(text))!;
const apply = (s: EditorState, changes: any) => s.update({ changes }).state.doc.toString();
const slice = (s: EditorState, b: { from: number; to: number }) => s.sliceDoc(b.from, b.to);

const DOC = `---
title: x
---
# Head

Para one
line two

- a
  - b
  - c
- d

| a | b |
| - | - |
| 1 | 2 |

\`\`\`js
x
\`\`\`

> [!note] Title
> body`;

describe("blockAt", () => {
  const s = state(DOC);
  test("finds each kind of block", () => {
    expect(at(s, "# Head")).toMatchObject({ kind: "heading", heading: "Head" });
    expect(slice(s, at(s, "line two"))).toBe("Para one\nline two");
    expect(slice(s, at(s, "- a"))).toBe("- a\n  - b\n  - c");
    expect(at(s, "  - b")).toMatchObject({ kind: "item", indent: "  " });
    expect(slice(s, at(s, "| 1"))).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(slice(s, at(s, "x\n```"))).toBe("```js\nx\n```");
    expect(at(s, "> body")).toMatchObject({ kind: "quote" });
  });
  test("none on blank lines or the frontmatter", () => {
    expect(blockAt(s, s.doc.line(5).from)).toBeNull();
    expect(blockAt(s, s.doc.toString().indexOf("title"))).toBeNull();
  });
});

describe("moveBlock", () => {
  test("a list item takes its children, and lands at the target's level", () => {
    const s = state("- a\n  - b\n  - c\n- d\n- e");
    const out = apply(s, moveBlock(s, at(s, "- a"), at(s, "- e"), "after"));
    expect(out).toBe("- d\n- e\n- a\n  - b\n  - c");
  });
  test("a nested item dragged out to the top level loses its indent", () => {
    const s = state("- a\n  - b\n- c");
    expect(apply(s, moveBlock(s, at(s, "  - b"), at(s, "- c"), "after"))).toBe("- a\n- c\n- b");
  });
  test("paragraphs keep one blank line between them", () => {
    const s = state("A\n\nB\n\nC");
    expect(apply(s, moveBlock(s, at(s, "C"), at(s, "A"), "before"))).toBe("C\n\nA\n\nB");
    expect(apply(s, moveBlock(s, at(s, "A"), at(s, "C"), "after"))).toBe("B\n\nC\n\nA");
    expect(apply(s, moveBlock(s, at(s, "B"), at(s, "A"), "before"))).toBe("B\n\nA\n\nC");
  });
  test("a table moves whole", () => {
    const s = state("Intro\n\n| a |\n| - |\n| 1 |\n\nEnd");
    expect(apply(s, moveBlock(s, at(s, "| 1"), at(s, "Intro"), "before"))).toBe("| a |\n| - |\n| 1 |\n\nIntro\n\nEnd");
  });
  test("no move onto itself, into itself, or to where it already is", () => {
    const s = state("- a\n  - b\n- c\n\nP");
    expect(moveBlock(s, at(s, "- a"), at(s, "- a"), "after")).toBeNull();
    expect(moveBlock(s, at(s, "- a"), at(s, "  - b"), "after")).toBeNull();
    expect(moveBlock(s, at(s, "- a"), at(s, "- c"), "before")).toBeNull();
  });
});

describe("removalRange and duplicate", () => {
  test("delete leaves no doubled blank line", () => {
    const s = state("A\n\nB\n\nC");
    const r = removalRange(s, at(s, "B"));
    expect(apply(s, { from: r.from, to: r.to })).toBe("A\n\nC");
    const last = removalRange(s, at(s, "C"));
    expect(apply(s, { from: last.from, to: last.to })).toBe("A\n\nB");
  });
  test("duplicate puts a copy after", () => {
    const s = state("- a\n  - b\n- c");
    expect(apply(s, duplicateBlock(s, at(s, "- a")))).toBe("- a\n  - b\n- a\n  - b\n- c");
  });
});

describe("turnInto", () => {
  test("paragraph to heading, to-do, quote and callout", () => {
    const s = state("Hello\n\nX");
    const b = at(s, "Hello");
    expect(apply(s, turnInto(s, b, "h2"))).toBe("## Hello\n\nX");
    expect(apply(s, turnInto(s, b, "todo"))).toBe("- [ ] Hello\n\nX");
    expect(apply(s, turnInto(s, b, "callout"))).toBe("> [!note]\n> Hello\n\nX");
  });
  test("a callout back to text, and a bullet to a to-do keeping its indent", () => {
    const s = state("> [!tip] Look\n> here");
    expect(apply(s, turnInto(s, at(s, "here"), "paragraph"))).toBe("Look\nhere");
    const l = state("- a\n  - b");
    expect(apply(l, turnInto(l, at(l, "  - b"), "todo"))).toBe("- a\n  - [ ] b");
  });
  test("not tables or code", () => {
    const s = state("```\nx\n```");
    expect(turnInto(s, at(s, "x"), "h1")).toBeNull();
  });
});
