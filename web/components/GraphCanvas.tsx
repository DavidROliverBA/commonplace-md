// The graph drawn on a canvas (after Capacities), shared by the graph page and the side panel's
// Graph tab. A note of a type is its type's icon in its colour; a note without one is a dot. A
// link from a property carries the property's name; a link in the text is a fainter line. The
// centre note (when there is one) is held in the middle and ringed. Drag to pan, wheel or pinch
// to zoom, drag a note to move it, tap one to open it. Positions are kept by note, so Show more
// and changed filters grow the picture rather than redrawing it from scratch. The timeline (F21)
// passes the notes outside its range: they fade or vanish but keep their place in the layout, so
// moving the range or playing it never shuffles the picture.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { GraphEdge, GraphNode, GraphType } from "../lib/graph";
import { iconPath } from "../ui/Icon";

export interface GraphHandle {
  zoomBy(f: number): void;
  fit(): void;
  focusOn(id: number): void;
  exportPng(name: string): void;
}

interface Props {
  nodes: (GraphNode & { deg: number })[];
  edges: GraphEdge[];
  types: GraphType[];
  centre?: number | null;
  simplified?: boolean;
  /** Smaller type and fewer labels: the side panel. */
  compact?: boolean;
  label: string;
  onOpen: (id: number) => void;
  onZoom?: (k: number) => void;
  /** Notes outside the timeline's range: faded, or not drawn at all with `hideOutside`. */
  outside?: Set<number>;
  hideOutside?: boolean;
  /** Someone pressed on the graph (the timeline pauses its Play). */
  onTouch?: () => void;
}

interface Body {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
type Drawn = GraphNode & { deg: number; b: Body };

/** A type's colour name to its design token (as `.colour-*` in styles/types.css). */
const TOKEN: Record<string, string> = { purple: "--accent", blue: "--info", green: "--ok", amber: "--warn", red: "--danger", grey: "--muted" };
const icons = new Map<string, Path2D | null>();
const pathFor = (name: string) => {
  if (!icons.has(name)) {
    const d = iconPath(name);
    icons.set(name, d ? new Path2D(d) : null);
  }
  return icons.get(name)!;
};

const K_MIN = 0.1;
const K_MAX = 4;

export const GraphCanvas = forwardRef<GraphHandle, Props>(function GraphCanvas(p, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // What the drawing loop reads: the latest props, kept in a ref so the loop isn't restarted.
  const live = useRef({ p, nodes: [] as Drawn[], edges: [] as [Drawn, Drawn, string | null][], alpha: 1, settled: false, touched: false });
  const bodies = useRef(new Map<number, Body>());
  const view = useRef({ x: 0, y: 0, k: 1 });
  const flash = useRef<{ id: number; until: number } | null>(null);
  live.current.p = p;

  // New nodes or links: keep everyone's place, start newcomers beside a neighbour that has one.
  useEffect(() => {
    const L = live.current;
    const byId = new Map<number, Drawn>();
    const near = new Map<number, number>();
    for (const e of p.edges) (near.set(e.source, e.target), near.set(e.target, e.source));
    p.nodes.forEach((n, i) => {
      let b = bodies.current.get(n.id);
      if (!b) {
        const friend = bodies.current.get(near.get(n.id) ?? -1);
        const a = i * 2.399963; // golden-angle spiral keeps the first frames tidy
        const r = friend ? 30 : 14 * Math.sqrt(i + 1);
        b = { id: n.id, x: (friend?.x ?? 0) + Math.cos(a) * r, y: (friend?.y ?? 0) + Math.sin(a) * r, vx: 0, vy: 0 };
        bodies.current.set(n.id, b);
      }
      byId.set(n.id, { ...n, b });
    });
    L.nodes = [...byId.values()];
    L.edges = p.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => [byId.get(e.source)!, byId.get(e.target)!, e.label]);
    L.alpha = Math.max(L.alpha, L.nodes.length > 1 ? 0.8 : 0.1);
    L.settled = false;
    L.touched = false;
  }, [p.nodes, p.edges]);

  useImperativeHandle(ref, () => ({
    zoomBy(f) {
      view.current.k = Math.min(K_MAX, Math.max(K_MIN, view.current.k * f));
      live.current.touched = true;
      p.onZoom?.(view.current.k);
    },
    fit: () => fit(),
    focusOn(id) {
      const n = live.current.nodes.find((x) => x.id === id);
      if (!n) return;
      view.current.k = Math.max(view.current.k, 1.2);
      view.current.x = -n.b.x * view.current.k;
      view.current.y = -n.b.y * view.current.k;
      live.current.touched = true;
      flash.current = { id, until: performance.now() + 2500 };
      p.onZoom?.(view.current.k);
    },
    exportPng(name) {
      canvas.current?.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${name}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, "image/png");
    },
  }));

  function fit() {
    const el = canvas.current;
    const ns = live.current.nodes;
    if (!el || !ns.length) return;
    const xs = ns.map((n) => n.b.x);
    const ys = ns.map((n) => n.b.y);
    const w = Math.max(...xs) - Math.min(...xs) + 180; // room for names either side
    const h = Math.max(...ys) - Math.min(...ys) + 140;
    const k = Math.min(K_MAX, Math.max(K_MIN, Math.min(el.clientWidth / w, el.clientHeight / h, 1.6)));
    // In place: the drawing loop holds this object.
    Object.assign(view.current, { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k });
    live.current.p.onZoom?.(k);
  }

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const L = live.current;
    const v = view.current;
    let raf = 0;
    let frame = 0;
    let hover: Drawn | null = null;
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim() || "#888";

    const resize = () => {
      const dpr = devicePixelRatio || 1;
      el.width = el.clientWidth * dpr;
      el.height = el.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const typeOf = (n: Drawn) => (n.type ? (L.p.types.find((t) => t.name.toLowerCase() === n.type!.toLowerCase()) ?? null) : null);
    // Zoomed out to fit, notes and words keep a readable size on screen (down to about half size).
    const grow = () => Math.min(1.8, Math.max(1, 0.8 / v.k));
    const radius = (n: Drawn) => (typeOf(n) && !L.p.simplified ? 10 + Math.min(Math.sqrt(n.deg) * 1.4, 8) : 3.5 + Math.min(Math.sqrt(n.deg) * 1.5, 8)) * grow();

    function step() {
      const { nodes, edges } = L;
      if (L.alpha < 0.003) {
        if (!L.settled && !L.touched) fit();
        L.settled = true;
        return;
      }
      // Repulsion (O(n²): fine for a few thousand notes), springs on links, gravity to the centre.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!.b;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!.b;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) (dx = Math.random() - 0.5), (dy = Math.random() - 0.5), (d2 = 0.5);
          if (d2 > 160000) continue;
          const f = (1400 / d2) * L.alpha;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }
      for (const [na, nb, label] of edges) {
        const a = na.b;
        const b = nb.b;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - (label ? 110 : 80)) / d) * 0.04 * L.alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of nodes) {
        const b = n.b;
        b.vx -= b.x * 0.004 * L.alpha;
        b.vy -= b.y * 0.004 * L.alpha;
        b.vx *= 0.6;
        b.vy *= 0.6;
        if (n.id === L.p.centre) (b.x = 0), (b.y = 0);
        else if (n !== dragging) (b.x += b.vx), (b.y += b.vy);
      }
      L.alpha *= 0.985;
      // Keep it all in view while it settles, until someone pans, zooms or drags.
      if (!L.touched && ++frame % 8 === 0) fit();
    }

    function draw() {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const k = v.k;
      const fs = (L.p.compact ? 11 : 12) / Math.max(k, 0.6);
      // A solid background, so an exported picture isn't see-through.
      ctx.fillStyle = token("--bg");
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + v.x, h / 2 + v.y);
      ctx.scale(k, k);
      const lit = flash.current && flash.current.until > performance.now() ? L.nodes.find((n) => n.id === flash.current!.id) : null;
      const focus = hover ?? lit ?? null;
      const linked = focus ? new Set(L.edges.flatMap(([a, b]) => (a === focus || b === focus ? [a, b] : []))) : null;

      const out = L.p.outside;
      const away = (n: Drawn) => !!out?.has(n.id);
      for (const [a, b, label] of L.edges) {
        const gone = away(a) || away(b);
        if (gone && L.p.hideOutside) continue;
        const on = !!focus && (a === focus || b === focus);
        ctx.globalAlpha = gone ? 0.08 : focus && !on ? 0.2 : label ? 0.9 : 0.6;
        ctx.strokeStyle = on ? token("--accent") : label ? token("--muted") : token("--line");
        ctx.lineWidth = (label ? 1.4 : 1) / k;
        ctx.beginPath();
        ctx.moveTo(a.b.x, a.b.y);
        ctx.lineTo(b.b.x, b.b.y);
        ctx.stroke();
      }
      // Property names on their links: close up, or along the links of the note in focus.
      ctx.font = `${fs * 0.85}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [a, b, label] of L.edges) {
        if (!label || away(a) || away(b) || !(k >= 0.9 || L.nodes.length <= 40 || (focus && (a === focus || b === focus)))) continue;
        if (focus && a !== focus && b !== focus) continue;
        const mx = (a.b.x + b.b.x) / 2;
        const my = (a.b.y + b.b.y) / 2;
        const tw = ctx.measureText(label).width + 8 / k;
        ctx.globalAlpha = 1;
        ctx.fillStyle = token("--bg");
        ctx.fillRect(mx - tw / 2, my - fs * 0.6, tw, fs * 1.2);
        ctx.fillStyle = token("--muted");
        ctx.fillText(label, mx, my);
      }

      ctx.textBaseline = "alphabetic";
      for (const n of L.nodes) {
        const gone = away(n);
        if (gone && L.p.hideOutside) continue;
        const t = typeOf(n);
        const r = radius(n);
        const colour = t ? token(TOKEN[t.colour] ?? "--accent") : token("--node");
        const isCentre = n.id === L.p.centre;
        ctx.globalAlpha = gone ? 0.15 : linked && !linked.has(n) && n !== focus ? 0.3 : 1;
        if (t && !L.p.simplified) {
          ctx.fillStyle = token("--bg");
          ctx.strokeStyle = colour;
          ctx.lineWidth = n === focus ? 2.5 : 1.6;
          ctx.beginPath();
          ctx.arc(n.b.x, n.b.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          const icon = pathFor(t.icon);
          if (icon) {
            const s = r * 1.15;
            ctx.save();
            ctx.translate(n.b.x - s / 2, n.b.y - s / 2);
            ctx.scale(s / 24, s / 24);
            ctx.strokeStyle = colour;
            ctx.lineWidth = 2;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.stroke(icon);
            ctx.restore();
          }
        } else {
          ctx.fillStyle = n === focus ? token("--accent") : colour;
          ctx.beginPath();
          ctx.arc(n.b.x, n.b.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (isCentre || n === lit) {
          ctx.strokeStyle = token("--accent");
          ctx.lineWidth = 2.5 / k;
          ctx.beginPath();
          ctx.arc(n.b.x, n.b.y, r + 4 / k, 0, Math.PI * 2);
          ctx.stroke();
        }
        const named = !gone && (isCentre || n === focus || (linked?.has(n) ?? false) || L.nodes.length <= 40 || k > (L.p.compact ? 1.1 : 0.9) || n.deg > 6);
        if (named) {
          ctx.fillStyle = token("--text");
          ctx.font = `${isCentre ? "600 " : ""}${fs}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.title, n.b.x, n.b.y + r + fs + ((isCentre || n === lit ? 8 : 3) / k));
        }
      }
      ctx.restore();
    }

    const loop = () => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const toWorld = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect();
      return { x: (cx - rect.left - el.clientWidth / 2 - v.x) / v.k, y: (cy - rect.top - el.clientHeight / 2 - v.y) / v.k };
    };
    const nodeAt = (cx: number, cy: number) => {
      const p = toWorld(cx, cy);
      // The nearest note within its circle, or within a finger's width of a small one.
      let best: Drawn | null = null;
      let bd = Infinity;
      for (const n of L.nodes) {
        if (L.p.hideOutside && L.p.outside?.has(n.id)) continue;
        const d = (n.b.x - p.x) ** 2 + (n.b.y - p.y) ** 2;
        const r = Math.max(radius(n), 14 / v.k);
        if (d <= r * r && d < bd) (bd = d), (best = n);
      }
      return best;
    };

    let dragging: Drawn | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinch: { d: number; k: number } | null = null;
    const zoomed = () => ((L.touched = true), L.p.onZoom?.(v.k));

    const down = (e: PointerEvent) => {
      L.p.onTouch?.();
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: v.k };
        dragging = null;
      } else dragging = nodeAt(e.clientX, e.clientY);
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        hover = nodeAt(e.clientX, e.clientY);
        el.style.cursor = hover ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        v.k = Math.min(K_MAX, Math.max(K_MIN, pinch.k * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.d)));
        zoomed();
      } else if (dragging && dragging.id !== L.p.centre) {
        const p = toWorld(e.clientX, e.clientY);
        dragging.b.x = p.x;
        dragging.b.y = p.y;
        L.alpha = Math.max(L.alpha, 0.3);
        L.touched = true;
      } else if (moved) {
        v.x += dx;
        v.y += dy;
        L.touched = true;
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!moved && dragging) L.p.onOpen(dragging.id);
      dragging = null;
    };
    const leave = () => (hover = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      v.k = Math.min(K_MAX, Math.max(K_MIN, v.k * Math.exp(-e.deltaY * 0.0015)));
      zoomed();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  return <canvas ref={canvas} className="graph-canvas" role="img" aria-label={p.label} />;
});
