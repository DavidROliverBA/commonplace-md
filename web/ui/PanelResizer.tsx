// The drag handle on a side panel's inner edge, as in Floe: drag to make the file panel or the
// side panel wider (the graph in the side panel wants room), double-click to put it back. It's a
// separator, so the keyboard can do it too: arrows move 16px, Home and End go to the narrowest
// and widest. The widths are remembered in this browser; on a phone the panels are drawers and
// there's no handle.

import { useRef, useState } from "react";

const MIN = 200;
const MAX = 720;
const STEP = 16;
/** Room the note keeps however wide the panels get. */
const NOTE_MIN = 360;
export const PANEL_WIDTHS = { left: 272, right: 280 } as const;

const key = (side: "left" | "right") => `cp:${side}-w`;
function load(side: "left" | "right"): number {
  try {
    const w = Number(localStorage.getItem(key(side)));
    if (w >= MIN && w <= MAX) return w;
  } catch {}
  return PANEL_WIDTHS[side];
}

/** Both panels' widths, remembered here, and a setter that keeps room for the note. */
export function usePanelWidths() {
  const [widths, setWidths] = useState(() => ({ left: load("left"), right: load("right") }));
  const resize = (side: "left" | "right", w: number, other: number) => {
    const most = Math.max(MIN, Math.min(MAX, window.innerWidth - other - NOTE_MIN));
    const width = Math.round(Math.min(most, Math.max(MIN, w)));
    setWidths((s) => ({ ...s, [side]: width }));
    try {
      localStorage.setItem(key(side), String(width));
    } catch {}
  };
  return { widths, resize };
}

export function PanelResizer({ side, width, other, resize }: { side: "left" | "right"; width: number; other: number; resize: (side: "left" | "right", w: number, other: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sign = side === "left" ? 1 : -1;
  const label = side === "left" ? "file panel" : "side panel";
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  return (
    <div
      className={`panel-resizer ${side}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Width of the ${label}`}
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => drag.current && resize(side, drag.current.width + sign * (e.clientX - drag.current.x), other)}
      onPointerUp={end}
      onLostPointerCapture={end}
      onDoubleClick={() => resize(side, PANEL_WIDTHS[side], other)}
      onKeyDown={(e) => {
        const to =
          e.key === "ArrowLeft" || e.key === "ArrowRight" ? width + (e.key === "ArrowRight" ? STEP : -STEP) * sign : e.key === "Home" ? MIN : e.key === "End" ? MAX : null;
        if (to === null) return;
        e.preventDefault();
        resize(side, to, other);
      }}
    />
  );
}
