// Drag notes and folders in the file tree, with a mouse or a finger. Pointer events rather than
// HTML5 drag-and-drop, which iPhone Safari doesn't support reliably. A mouse drag starts after a
// few pixels of movement; a touch drag starts after a long press, so a plain swipe still scrolls.
// Drop targets are elements with data-drop="<folder path>" ("" is the vault root).

import { useEffect, useMemo, useRef, useState } from "react";
import { type DragItem, moveTarget } from "./move";

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 400;

interface Pending {
  item: DragItem;
  label: string;
  x: number;
  y: number;
  touch: boolean;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** bind(item, label) goes on each draggable row; drag and over say what's moving and where it
 *  would land; ghost is the floating label to render. */
export function useTreeDrag(opts: { enabled: boolean; onDrop: (item: DragItem, folder: string) => void }) {
  const pending = useRef<Pending | null>(null);
  const overRef = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [drag, setDrag] = useState<{ item: DragItem; label: string } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [over, setOverState] = useState<string | null>(null);
  // Created once: window listeners must be removed with the same function identities they were
  // added with. Everything inside reads refs or stable state setters.
  const h = useMemo(() => {
    const setOver = (v: string | null) => {
      overRef.current = v;
      setOverState(v);
    };

    // While a touch drag is active the page must not scroll; only a non-passive touchmove can stop it.
    const blockScroll = (e: TouchEvent) => e.preventDefault();

    function cleanup() {
      const p = pending.current;
      if (p?.timer) clearTimeout(p.timer);
      pending.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("touchmove", blockScroll);
      setDrag(null);
      setOver(null);
    }

    function begin(x: number, y: number) {
      const p = pending.current;
      if (!p) return;
      p.active = true;
      setDrag({ item: p.item, label: p.label });
      setPos({ x, y });
      if (p.touch) {
        document.addEventListener("touchmove", blockScroll, { passive: false });
        navigator.vibrate?.(10);
      }
    }

    function onMove(e: PointerEvent) {
      const p = pending.current;
      if (!p) return;
      if (!p.active) {
        const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.touch && moved > TOUCH_SLOP) return cleanup(); // a scroll, not a drag
        if (!p.touch && moved > MOUSE_SLOP) begin(e.clientX, e.clientY);
        return;
      }
      setPos({ x: e.clientX, y: e.clientY });
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop]");
      const folder = target ? (target.dataset.drop ?? null) : null;
      setOver(folder !== null && moveTarget(p.item, folder) !== null ? folder : null);
      // Scroll the tree when dragging near its top or bottom edge.
      const scroller = target?.closest(".sidebar-scroll") ?? document.querySelector(".sidebar-scroll");
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (e.clientY < r.top + 32) scroller.scrollBy(0, -12);
        else if (e.clientY > r.bottom - 32) scroller.scrollBy(0, 12);
      }
    }

    function onUp() {
      const p = pending.current;
      const folder = overRef.current;
      if (p?.active) {
        // The click that follows pointerup would otherwise open the dragged note or fold the folder.
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 50);
        if (folder !== null) optsRef.current.onDrop(p.item, folder);
      }
      cleanup();
    }

    function onCancel() {
      cleanup();
    }
    return { cleanup, begin, onMove, onUp, onCancel };
  }, []);

  useEffect(() => h.cleanup, []);

  /** Props for a draggable row. */
  function bind(item: DragItem, label: string) {
    return {
      onPointerDown(e: React.PointerEvent) {
        if (!optsRef.current.enabled || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        h.cleanup();
        const touch = e.pointerType !== "mouse";
        const p: Pending = { item, label, x: e.clientX, y: e.clientY, touch, active: false };
        if (touch) p.timer = setTimeout(() => h.begin(p.x, p.y), LONG_PRESS_MS);
        pending.current = p;
        window.addEventListener("pointermove", h.onMove);
        window.addEventListener("pointerup", h.onUp);
        window.addEventListener("pointercancel", h.onCancel);
      },
      onClickCapture(e: React.MouseEvent) {
        if (suppressClick.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      // A long press would otherwise open the iOS link menu or the Android context menu.
      onContextMenu(e: React.MouseEvent) {
        if (pending.current?.touch) e.preventDefault();
      },
    };
  }

  const ghost = drag ? (
    <div className="drag-ghost" style={{ left: pos.x + 12, top: pos.y + 8 }}>
      {drag.label}
    </div>
  ) : null;

  return { drag, over, bind, ghost };
}
