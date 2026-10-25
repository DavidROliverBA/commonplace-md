// The graph's timeline (F21): a strip under the graph with notes per month as bars and a range
// with two handles. Notes outside the range fade, or are hidden; a link shows only when both its
// notes are in range (GraphCanvas). Play grows the range a month at a time from the first month
// to the last in about ten seconds; pressing on the graph pauses it. The handles are sliders:
// arrow keys move a day, Page Up and Page Down a month. The range is kept in the page's address.

import { useEffect, useMemo } from "react";
import { addMonths, type DayRange, dayFromNumber, dayNumber, daySpan, perMonth, rangeWords } from "../lib/graph";
import { Icon } from "../ui/Icon";

interface Props {
  nodes: { id: number; when: string }[];
  range: DayRange;
  setRange: (r: DayRange) => void;
  /** How many notes are in range. */
  showing: number;
  hide: boolean;
  setHide: (on: boolean) => void;
  playing: boolean;
  setPlaying: (on: boolean) => void;
  onClose: () => void;
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const short = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

export function GraphTimeline(p: Props) {
  const span = useMemo(() => daySpan(p.nodes), [p.nodes]);
  const months = useMemo(() => (span ? perMonth(p.nodes, span) : []), [p.nodes, span]);
  const most = Math.max(1, ...months.map((m) => m.count));

  // Play: the end steps on a month at a time from the first month to the last.
  useEffect(() => {
    if (!p.playing || !span) return;
    if (p.range.to >= span.to) return p.setPlaying(false);
    const ms = reduced() ? 800 : Math.min(1000, Math.max(150, 10_000 / Math.max(1, months.length)));
    const t = setTimeout(() => {
      const next = addMonths(p.range.to, 1);
      p.setRange({ from: span.from, to: next > span.to ? span.to : next });
    }, ms);
    return () => clearTimeout(t);
  }, [p.playing, p.range, span]);

  if (!span) return null;
  const lo = dayNumber(span.from);
  const hi = Math.max(dayNumber(span.to), lo + 1);
  const at = (d: string) => ((dayNumber(d) - lo) / (hi - lo)) * 100;
  const clamp = (d: string) => (d < span.from ? span.from : d > span.to ? span.to : d);
  // A range from the address can reach past the notes: the handles stop at the first and last.
  const shown = { from: clamp(p.range.from), to: clamp(p.range.to) };

  const move = (end: "from" | "to", d: string) => {
    d = clamp(d);
    p.setPlaying(false);
    p.setRange(end === "from" ? { from: d, to: d > shown.to ? d : shown.to } : { from: d < shown.from ? d : shown.from, to: d });
  };
  const slider = (end: "from" | "to") => (
    <input
      type="range"
      className={`timeline-handle timeline-${end}`}
      min={lo}
      max={hi}
      step={1}
      value={dayNumber(shown[end])}
      aria-label={end === "from" ? "Start of the range" : "End of the range"}
      aria-valuetext={short(shown[end])}
      onChange={(e) => move(end, dayFromNumber(Number(e.target.value)))}
      onKeyDown={(e) => {
        if (e.key !== "PageUp" && e.key !== "PageDown") return;
        e.preventDefault();
        move(end, addMonths(shown[end], e.key === "PageUp" ? 1 : -1));
      }}
    />
  );
  const play = () => {
    if (p.playing) return p.setPlaying(false);
    // From the start, unless a paused run is part way through.
    if (p.range.to >= span.to || p.range.from !== span.from) p.setRange({ from: span.from, to: clamp(addMonths(`${span.from.slice(0, 7)}-01`, 1)) });
    p.setPlaying(true);
  };
  const whole = p.range.from === span.from && p.range.to === span.to;

  return (
    <section className="graph-timeline" aria-label="Timeline">
      <div className="timeline-bars" aria-hidden="true">
        {months.map((m) => {
          const inRange = `${m.month}-31` >= p.range.from && `${m.month}-01` <= p.range.to;
          // Each month over its own days, on the handles' scale.
          const first = clamp(`${m.month}-01`);
          const next = Math.min(dayNumber(addMonths(`${m.month}-01`, 1)), hi);
          return (
            <span
              key={m.month}
              className={`timeline-bar${inRange ? " in" : ""}`}
              style={{ left: `${at(first)}%`, width: `${((next - dayNumber(first)) / (hi - lo)) * 100}%`, height: `${m.count ? Math.max(8, (m.count / most) * 100) : 0}%` }}
              title={`${monthName(m.month)}: ${m.count} note${m.count === 1 ? "" : "s"}`}
              onClick={() => (p.setPlaying(false), p.setRange({ from: clamp(`${m.month}-01`), to: clamp(dayFromNumber(dayNumber(addMonths(`${m.month}-01`, 1)) - 1)) }))}
            />
          );
        })}
      </div>
      <div className="timeline-range">
        <span className="timeline-fill" style={{ left: `${at(shown.from)}%`, right: `${100 - at(shown.to)}%` }} />
        {slider("from")}
        {slider("to")}
      </div>
      <div className="timeline-controls">
        <button className="quiet" onClick={play} aria-label={p.playing ? "Pause" : "Play: grow the graph month by month"}>
          <Icon name={p.playing ? "pause" : "play"} size={16} /> <span className="only-wide">{p.playing ? "Pause" : "Play"}</span>
        </button>
        <span className="timeline-words" aria-live={p.playing ? "off" : "polite"}>
          Showing {p.showing} note{p.showing === 1 ? "" : "s"}, {rangeWords(p.range)}
        </span>
        {!whole && (
          <button className="link" onClick={() => (p.setPlaying(false), p.setRange(span))}>
            All dates
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={p.hide} onChange={(e) => p.setHide(e.target.checked)} /> Hide the rest
        </label>
        <button className="icon-btn" onClick={p.onClose} aria-label="Close the timeline">
          <Icon name="x" size={16} />
        </button>
      </div>
    </section>
  );
}
