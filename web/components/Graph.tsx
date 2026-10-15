// Force-directed link graph on a canvas: drag to pan, wheel or pinch to zoom, tap a node to open.

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { navigate, noteUrl } from "../lib/router";
import { PanelToggle } from "../ui/PanelToggle";

interface GNode {
  id: number;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  deg: number;
}

export function Graph({ vaultId, leftOpen, onToggleLeft, rightOpen, onToggleRight }: { vaultId: number; leftOpen: boolean; onToggleLeft: () => void; rightOpen: boolean; onToggleRight: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null);
  const [orphans, setOrphans] = useState(true);

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    let nodes: GNode[] = [];
    let edges: [GNode, GNode][] = [];
    const view = { x: 0, y: 0, k: 1 };
    let hover: GNode | null = null;
    let alpha = 1;

    const css = getComputedStyle(document.documentElement);
    const colour = (v: string) => css.getPropertyValue(v).trim() || "#888";

    api<{ nodes: { id: number; title: string }[]; edges: { source: number; target: number }[] }>(`/vaults/${vaultId}/graph`).then((g) => {
      if (disposed) return;
      const byId = new Map<number, GNode>();
      const deg = new Map<number, number>();
      for (const e of g.edges) {
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
      }
      const keep = g.nodes.filter((n) => orphans || deg.get(n.id));
      keep.forEach((n, i) => {
        const a = i * 2.399963; // golden-angle spiral start keeps the first frames tidy
        const r = 12 * Math.sqrt(i + 1);
        byId.set(n.id, { id: n.id, title: n.title, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: deg.get(n.id) ?? 0 });
      });
      nodes = [...byId.values()];
      edges = g.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => [byId.get(e.source)!, byId.get(e.target)!]);
      setStats({ nodes: nodes.length, edges: edges.length });
      alpha = 1;
    });

    const resize = () => {
      const dpr = devicePixelRatio || 1;
      el.width = el.clientWidth * dpr;
      el.height = el.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    function step() {
      if (alpha < 0.002) return;
      // Repulsion (O(n²) — fine for a few thousand notes), springs on edges, gravity to centre.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) (dx = Math.random() - 0.5), (dy = Math.random() - 0.5), (d2 = 0.5);
          if (d2 > 160000) continue;
          const f = (900 / d2) * alpha;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }
      for (const [a, b] of edges) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 60) / d) * 0.04 * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of nodes) {
        n.vx -= n.x * 0.004 * alpha;
        n.vy -= n.y * 0.004 * alpha;
        n.vx *= 0.6;
        n.vy *= 0.6;
        if (n !== dragging) {
          n.x += n.vx;
          n.y += n.vy;
        }
      }
      alpha *= 0.99;
    }

    function draw() {
      const w = el.clientWidth;
      const h = el.clientHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + view.x, h / 2 + view.y);
      ctx.scale(view.k, view.k);
      const linked = hover ? new Set(edges.flatMap(([a, b]) => (a === hover || b === hover ? [a, b] : []))) : null;
      ctx.lineWidth = 1 / view.k;
      for (const [a, b] of edges) {
        const on = hover && (a === hover || b === hover);
        ctx.strokeStyle = on ? colour("--accent") : colour("--line");
        ctx.globalAlpha = hover && !on ? 0.25 : 0.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (const n of nodes) {
        const r = 3 + Math.sqrt(n.deg) * 1.6;
        ctx.globalAlpha = linked && !linked.has(n) && n !== hover ? 0.3 : 1;
        ctx.fillStyle = n === hover ? colour("--accent") : colour("--node");
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (view.k > 0.9 || n === hover || (linked?.has(n) ?? false) || n.deg > 6) {
          ctx.fillStyle = colour("--text");
          ctx.font = `${12 / Math.max(view.k, 0.6)}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.title, n.x, n.y + r + 12 / Math.max(view.k, 0.6));
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
      return { x: (cx - rect.left - el.clientWidth / 2 - view.x) / view.k, y: (cy - rect.top - el.clientHeight / 2 - view.y) / view.k };
    };
    const nodeAt = (cx: number, cy: number) => {
      const p = toWorld(cx, cy);
      let best: GNode | null = null;
      let bd = (14 / view.k) ** 2;
      for (const n of nodes) {
        const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
        if (d < bd) (bd = d), (best = n);
      }
      return best;
    };

    let dragging: GNode | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinch: { d: number; k: number } | null = null;

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: view.k };
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
        view.k = Math.min(4, Math.max(0.15, pinch.k * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.d)));
      } else if (dragging) {
        const p = toWorld(e.clientX, e.clientY);
        dragging.x = p.x;
        dragging.y = p.y;
        alpha = Math.max(alpha, 0.3);
      } else {
        view.x += dx;
        view.y += dy;
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!moved && dragging) navigate(noteUrl(vaultId, dragging.id));
      dragging = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      view.k = Math.min(4, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [vaultId, orphans]);

  return (
    <div className="graph-view">
      <header className="note-header">
        <PanelToggle side="left" open={leftOpen} onToggle={onToggleLeft} />
        <h1 className="note-title">Graph</h1>
        <div className="note-actions">
          <label className="check">
            <input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> Show unlinked notes
          </label>
          {stats && (
            <span className="muted">
              {stats.nodes} notes · {stats.edges} links
            </span>
          )}
          <PanelToggle side="right" open={rightOpen} onToggle={onToggleRight} />
        </div>
      </header>
      <canvas ref={canvas} className="graph-canvas" />
    </div>
  );
}
