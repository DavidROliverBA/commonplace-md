// The `+` and `⋮⋮` handle beside a block (F12 step 2), as in Notion. On a laptop it follows the
// pointer down the left margin; on a phone, with no hover, it sits by the block with the cursor
// (just the ⋮⋮, whose menu has "Insert below").
//
//   +        a new line below the block (a new item in a list) with the `/` menu open
//   ⋮⋮ tap   turn into…, colour…, duplicate, copy a [[Note#heading]] link, delete
//   ⋮⋮ drag  move the block (a list item with its children, a table or code block whole), with a
//            line where it will land. A mouse drag starts after 5px; a finger after a 400ms press.
//
// Blocks come from the syntax tree (web/lib/blocks.ts); a move is one change, so one undo puts it
// back. A collaborator typing inside the block would lose their keystrokes to the deleted copy,
// so a move is refused while another person's cursor is in it.

import { startCompletion } from "@codemirror/autocomplete";
import type { ChangeSpec } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { iconElement } from "../ui/Icon";
import { menuAt, type MenuItem } from "../ui/Menu";
import { chooseDialog, toast } from "../ui/overlays";
import { type Block, blockAt, canTurn, duplicateBlock, moveBlock, removalRange, TURN_INTO, turnInto, type TurnInto } from "./blocks";
import { COMMANDS, currentCtx } from "./commands";

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 400;
const HANDLE_W = 44;

interface Opts {
  ytext: Y.Text;
  awareness: Awareness;
  /** The note's link text, for [[Note#heading]]. */
  title: () => string | null;
  /** "Make it a note of a type…" on a one-line block, when the vault has types; the cursor is
   *  on the block's line when it's called. */
  makeTyped?: { can: () => boolean; run: () => void };
}

/** Is someone else's cursor inside [from, to]? */
function remoteCursorIn(o: Opts, from: number, to: number): boolean {
  const doc = o.ytext.doc;
  if (!doc) return false;
  for (const [id, st] of o.awareness.getStates()) {
    if (id === o.awareness.clientID || !st.cursor?.head) continue;
    try {
      const p = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), doc);
      if (p && p.type === o.ytext && p.index >= from && p.index <= to) return true;
    } catch {
      // a cursor from a document state we don't have yet: not in this block
    }
  }
  return false;
}

const hover = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

function button(cls: string, icon: string, label: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cm-block-btn ${cls}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  const svg = iconElement(icon, 16);
  if (svg) b.append(svg);
  // Keep the editor focused (and the phone's keyboard up) when the handle is pressed.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/** The handle as a CodeMirror ViewPlugin; its buttons live in the editor's scroller, beside the text. */
export function blockHandle(o: Opts) {
  return ViewPlugin.fromClass(
    class {
      dom: HTMLDivElement;
      plus: HTMLButtonElement;
      grip: HTMLButtonElement;
      line: HTMLDivElement;
      block: Block | null = null;
      /** Kept visible while its menu is open or it's being dragged. */
      held = false;
      drag: { x: number; y: number; touch: boolean; active: boolean; block: Block; timer?: ReturnType<typeof setTimeout>; target: { block: Block; side: "before" | "after" } | null } | null = null;
      suppressClick = false;

      constructor(readonly view: EditorView) {
        this.dom = document.createElement("div");
        this.dom.className = "cm-block-handle";
        this.dom.hidden = true;
        this.plus = button("cm-block-plus", "plus", "Insert below");
        this.grip = button("cm-block-grip", "grip", "Drag to move, or click for options");
        this.dom.append(this.plus, this.grip);
        this.line = document.createElement("div");
        this.line.className = "cm-block-drop";
        this.line.hidden = true;
        view.scrollDOM.append(this.dom, this.line);

        this.plus.addEventListener("click", () => this.insertBelow());
        this.grip.addEventListener("click", () => {
          if (this.suppressClick) return void (this.suppressClick = false);
          this.openMenu();
        });
        this.grip.addEventListener("pointerdown", this.onDown);
        view.scrollDOM.addEventListener("mousemove", this.onHover);
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);
      }

      update(u: ViewUpdate) {
        if (this.drag?.active) return;
        if (!hover()) {
          // Phone: beside the cursor's block, while editing.
          if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) this.show(this.view.hasFocus || this.held ? blockAt(this.view.state, this.view.state.selection.main.head) : null);
          return;
        }
        if (this.block && u.docChanged) this.show(blockAt(u.state, u.changes.mapPos(this.block.from)));
        else if (this.block && u.geometryChanged) this.show(this.block);
      }

      destroy() {
        this.dom.remove();
        this.line.remove();
        this.view.scrollDOM.removeEventListener("mousemove", this.onHover);
        this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
        this.endDrag();
      }

      // ── where things go ──────────────────────────────────────────────────────────────

      /** The text column on screen (inside the content's padding). */
      column() {
        const c = this.view.contentDOM;
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        const left = r.left + (parseFloat(cs.paddingLeft) || 0);
        return { left, right: r.right - (parseFloat(cs.paddingRight) || 0) };
      }
      /** The text column's left edge, in scroller coordinates. */
      textLeft() {
        return this.column().left - this.view.scrollDOM.getBoundingClientRect().left + this.view.scrollDOM.scrollLeft;
      }
      /** A screen height, in scroller coordinates. */
      yOf(screenY: number) {
        return screenY - this.view.scrollDOM.getBoundingClientRect().top + this.view.scrollDOM.scrollTop;
      }
      /** Where the line (or block widget) at `pos` is drawn, on screen. Measured from the DOM:
       *  CodeMirror's height map is an estimate until widgets above it have been measured. */
      lineBox(pos: number): { top: number; bottom: number } {
        const view = this.view;
        try {
          const { node, offset } = view.domAtPos(pos);
          const start = node === view.contentDOM ? node.childNodes[offset] : node.nodeType === 1 ? node : node.parentElement;
          const el = (start as Element | null)?.closest?.(".cm-content > *");
          if (el) {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          }
        } catch {
          // not drawn: fall back to the height map
        }
        const b = view.lineBlockAt(pos);
        return { top: b.top + view.documentTop, bottom: b.bottom + view.documentTop };
      }

      show(b: Block | null) {
        const view = this.view;
        if (!b || view.state.readOnly || b.to > view.state.doc.length) {
          if (!this.held) {
            this.block = null;
            this.dom.hidden = true;
          }
          return;
        }
        this.block = b;
        this.dom.hidden = false;
        this.dom.classList.toggle("touch", !hover());
        const first = this.lineBox(b.from);
        // Centre it on the first line (a table or embed widget is one tall "line": use the top).
        const h = Math.min(first.bottom - first.top, 30);
        const indent = b.indent ? (view.coordsAtPos(b.from + b.indent.length)?.left ?? 0) - (view.coordsAtPos(b.from)?.left ?? 0) : 0;
        const w = hover() ? HANDLE_W : HANDLE_W / 2;
        this.dom.style.top = `${this.yOf(first.top) + h / 2}px`;
        this.dom.style.left = `${Math.max(0, this.textLeft() + Math.max(0, indent) - w - 2)}px`;
      }

      onHover = (e: MouseEvent) => {
        if (this.held || this.drag || !hover()) return;
        if (this.dom.contains(e.target as Node)) return;
        this.show(this.blockAtY(e.clientY));
      };
      onLeave = (e: MouseEvent) => {
        if (this.held || this.drag || this.dom.contains(e.relatedTarget as Node)) return;
        this.block = null;
        this.dom.hidden = true;
      };

      /** The block at a screen height, wherever the pointer is across the page. */
      blockAtY(y: number): Block | null {
        const pos = this.view.posAtCoords({ x: this.column().left + 4, y }, false);
        return blockAt(this.view.state, pos);
      }

      // ── + ────────────────────────────────────────────────────────────────────────────

      insertBelow(b = this.block) {
        const view = this.view;
        if (!b || view.state.readOnly) return;
        const first = view.state.doc.lineAt(b.from).text;
        const item = /^(\s*)([-*+]|\d+[.)])( \[[ xX]\])? /.exec(first);
        let insert: string;
        if (b.kind === "item" && item) {
          const n = /^\d+/.exec(item[2]!);
          const marker = n ? `${Number(n[0]) + 1}${item[2]!.slice(n[0].length)}` : item[2];
          insert = `\n${item[1]}${marker}${item[3] ? " [ ]" : ""} /`;
        } else {
          const next = view.state.doc.lineAt(b.to).number + 1;
          const trail = next <= view.state.doc.lines && view.state.doc.line(next).text.trim() ? "\n" : "";
          insert = `\n\n/${trail}`;
        }
        const cursor = b.to + insert.length - (insert.endsWith("\n") ? 1 : 0);
        view.dispatch({ changes: { from: b.to, insert }, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input.block" });
        view.focus();
        startCompletion(view);
      }

      // ── ⋮⋮ menu ──────────────────────────────────────────────────────────────────────

      openMenu() {
        const b = this.block;
        const view = this.view;
        if (!b || view.state.readOnly) return;
        this.held = true;
        const run = (changes: ChangeSpec, userEvent = "input.block") => {
          view.dispatch({ changes, userEvent });
          view.focus();
        };
        const items: MenuItem[] = [
          { label: "Insert below", icon: "plus", hidden: hover(), onSelect: () => this.insertBelow(b) },
          { label: "Turn into…", icon: "text", hidden: !canTurn(b), onSelect: () => void this.turn(b) },
          { label: "Colour…", icon: "sparkle", hidden: !(b.kind === "paragraph" || b.kind === "heading" || b.kind === "item"), onSelect: () => this.colour(b) },
          {
            label: "Make it a note of a type…",
            icon: "sparkle",
            hidden: !o.makeTyped?.can() || !(b.kind === "paragraph" || b.kind === "item") || view.state.doc.lineAt(b.from).number !== view.state.doc.lineAt(b.to).number,
            onSelect: () => {
              view.dispatch({ selection: { anchor: view.state.doc.lineAt(b.from).to } });
              o.makeTyped?.run();
            },
          },
          { label: "Duplicate", icon: "copy", onSelect: () => run(duplicateBlock(view.state, b)) },
          { label: "Copy link to heading", icon: "link", hidden: b.kind !== "heading" || !o.title(), onSelect: () => void this.copyLink(b) },
          { label: "Delete", icon: "trash", danger: true, onSelect: () => this.remove(b) },
        ];
        menuAt(this.grip, "Block", items, () => {
          this.held = false;
          if (!hover()) this.show(blockAt(view.state, view.state.selection.main.head));
        });
      }

      async turn(b: Block) {
        const kind = (await chooseDialog({ title: "Turn into", options: TURN_INTO.map((t) => ({ value: t.kind, label: t.label, icon: t.icon })), placeholder: "Heading, list, to-do, quote…" })) as TurnInto | null;
        const view = this.view;
        // The block may have moved while the dialog was open: find it again by its start.
        const now = kind && blockAt(view.state, Math.min(b.from, view.state.doc.length));
        const change = now && turnInto(view.state, now, kind);
        if (change) view.dispatch({ changes: change, userEvent: "input.block" });
        view.focus();
      }

      /** Select the block's text (past its markup) and open the colour picker (F10). */
      colour(b: Block) {
        const view = this.view;
        const line = view.state.doc.lineAt(b.from);
        const prefix = /^\s*(?:#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/.exec(line.text)![0].length;
        const to = b.kind === "paragraph" ? b.to : line.to;
        view.dispatch({ selection: { anchor: line.from + prefix, head: to } });
        view.focus();
        COMMANDS.find((c) => c.id === "format.colour")?.run(currentCtx());
      }

      async copyLink(b: Block) {
        const link = `[[${o.title()}#${b.heading}]]`;
        try {
          await navigator.clipboard.writeText(link);
          toast(`Copied ${link}`);
        } catch {
          toast("Couldn't copy the link", { tone: "error" });
        }
      }

      /** Delete it, with Undo that puts it back where it was even if the note changed since. */
      remove(b: Block) {
        const view = this.view;
        const cut = removalRange(view.state, b);
        const text = view.state.sliceDoc(cut.from, cut.to);
        view.dispatch({ changes: { from: cut.from, to: cut.to }, userEvent: "delete.block" });
        const at = Y.createRelativePositionFromTypeIndex(o.ytext, cut.from);
        this.show(null);
        toast("Block deleted", {
          undo: () => {
            const p = o.ytext.doc && Y.createAbsolutePositionFromRelativePosition(at, o.ytext.doc);
            const pos = Math.min(p?.index ?? cut.from, view.state.doc.length);
            view.dispatch({ changes: { from: pos, insert: text }, userEvent: "input.block" });
          },
        });
      }

      // ── ⋮⋮ drag ──────────────────────────────────────────────────────────────────────

      onDown = (e: PointerEvent) => {
        if (!this.block || this.view.state.readOnly || e.button > 0) return;
        const touch = e.pointerType !== "mouse";
        this.drag = { x: e.clientX, y: e.clientY, touch, active: false, block: this.block, target: null };
        if (touch) this.drag.timer = setTimeout(() => this.begin(), LONG_PRESS_MS);
        window.addEventListener("pointermove", this.onMove);
        window.addEventListener("pointerup", this.onUp);
        window.addEventListener("pointercancel", this.onCancel);
      };

      begin() {
        const d = this.drag;
        if (!d || d.active) return;
        d.active = true;
        this.held = true;
        this.view.dom.classList.add("cm-block-dragging");
        this.grip.classList.add("dragging");
        if (d.touch) {
          document.addEventListener("touchmove", this.blockScroll, { passive: false });
          navigator.vibrate?.(10);
        }
      }

      blockScroll = (e: TouchEvent) => e.preventDefault();

      onMove = (e: PointerEvent) => {
        const d = this.drag;
        if (!d) return;
        if (!d.active) {
          const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
          if (d.touch && moved > TOUCH_SLOP) return this.endDrag(); // a scroll, not a press
          if (!d.touch && moved > MOUSE_SLOP) this.begin();
          if (!d.active) return;
        }
        this.target(e.clientY);
        // Scroll the note when dragging near its top or bottom.
        const r = this.view.scrollDOM.getBoundingClientRect();
        if (e.clientY < r.top + 40) this.view.scrollDOM.scrollTop -= 12;
        else if (e.clientY > r.bottom - 40) this.view.scrollDOM.scrollTop += 12;
      };

      /** Work out where a drop at this height lands, and draw the line there. */
      target(y: number) {
        const d = this.drag!;
        const view = this.view;
        let t = this.blockAtY(y);
        // On a blank line: the block above it, or failing that the one below.
        if (!t) {
          const pos = view.posAtCoords({ x: this.column().left + 4, y }, false);
          const n = view.state.doc.lineAt(pos).number;
          for (let i = n - 1; i >= 1 && !t; i--) t = blockAt(view.state, view.state.doc.line(i).from);
          for (let i = n + 1; i <= view.state.doc.lines && !t; i++) t = blockAt(view.state, view.state.doc.line(i).from);
        }
        if (!t || (t.from >= d.block.from && t.to <= d.block.to)) {
          d.target = null;
          this.line.hidden = true;
          return;
        }
        const head = this.lineBox(t.from);
        const top = head.top;
        const bottom = this.lineBox(t.to).bottom;
        // A list item's children are blocks of their own; for an item, decide on its first line.
        const mid = t.kind === "item" ? (top + head.bottom) / 2 : (top + bottom) / 2;
        const side = y < mid ? "before" : "after";
        d.target = moveBlock(view.state, d.block, t, side) ? { block: t, side } : null;
        if (!d.target) return void (this.line.hidden = true);
        const indent = t.indent ? (view.coordsAtPos(t.from + t.indent.length)?.left ?? 0) - (view.coordsAtPos(t.from)?.left ?? 0) : 0;
        this.line.hidden = false;
        this.line.style.top = `${this.yOf(side === "before" ? top : bottom) - 1}px`;
        this.line.style.left = `${this.textLeft() + Math.max(0, indent)}px`;
        const col = this.column();
        this.line.style.width = `${Math.max(40, col.right - col.left - Math.max(0, indent))}px`;
      }

      onUp = () => {
        const d = this.drag;
        const t = d?.target;
        const active = d?.active;
        this.endDrag();
        if (!d || !active) return;
        // The click that ends a drag (if it lands on the grip) mustn't open the menu.
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (!t) return;
        const view = this.view;
        if (remoteCursorIn(o, d.block.from, d.block.to)) return toast("Someone else is editing that block, so it can't move just now");
        const changes = moveBlock(view.state, d.block, t.block, t.side);
        if (!changes) return;
        view.dispatch({ changes, userEvent: "move.drop", scrollIntoView: false });
        view.focus();
        this.show(null);
      };

      onCancel = () => this.endDrag();

      endDrag() {
        const d = this.drag;
        if (d?.timer) clearTimeout(d.timer);
        if (d?.active) this.held = false;
        this.drag = null;
        this.line.hidden = true;
        this.view.dom.classList.remove("cm-block-dragging");
        this.grip.classList.remove("dragging");
        window.removeEventListener("pointermove", this.onMove);
        window.removeEventListener("pointerup", this.onUp);
        window.removeEventListener("pointercancel", this.onCancel);
        document.removeEventListener("touchmove", this.blockScroll);
      }
    },
  );
}
