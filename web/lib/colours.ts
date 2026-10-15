// Coloured text and highlights (F10). Markdown has no colour syntax, so notes carry it the ways
// popular editor plugins write it, and Commonplace reads them all:
//
//   <mark style="background: #FFF3A3A6;">…</mark>   Highlightr, inline mode (its default)
//   <mark class="hltr-yellow">…</mark>               Highlightr, class mode
//   <span style="background:#hex">…</span>           Editing Toolbar, highlight
//   <font color="#hex">…</font>                      Editing Toolbar, text colour
//   <span style="color: #hex;">…</span>              hand-written HTML, and what Commonplace writes
//   =={red}…==                                       Hilo / Style Obmd
//
// Commonplace writes the first form for highlights and <span style="color"> for text: both show
// in other Markdown editors with no plugin. A note may never style anything else: only `color` and
// `background(-color)`, only on span, mark and font, and only plain colour values survive the
// sanitiser. Palette colours are drawn with theme-aware shades (tokens.css), so a red reads in the
// dark too; any other colour is shown as written.

export type ColourName = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "cyan" | "grey";

/** The palette, as written into notes: Highlightr's own highlight colours (so its notes match), and
 *  mid-tone text colours. */
export const PALETTE: { name: ColourName; label: string; text: string; highlight: string }[] = [
  { name: "red", label: "Red", text: "#D93025", highlight: "#FF5582A6" },
  { name: "orange", label: "Orange", text: "#E8710A", highlight: "#FFB86CA6" },
  { name: "yellow", label: "Yellow", text: "#B98900", highlight: "#FFF3A3A6" },
  { name: "green", label: "Green", text: "#188038", highlight: "#BBFABBA6" },
  { name: "blue", label: "Blue", text: "#1A73E8", highlight: "#ADCCFFA6" },
  { name: "purple", label: "Purple", text: "#8430CE", highlight: "#D2B3FFA6" },
];
/** Highlightr's other defaults, recognised when reading. */
const EXTRA_HIGHLIGHTS: Record<string, ColourName> = { "#ffb8eba6": "pink", "#abf7f7a6": "cyan", "#cacfd9a6": "grey" };
const NAMES = new Set<ColourName>(["red", "orange", "yellow", "green", "blue", "purple", "pink", "cyan", "grey"]);

const NAMED_COLOURS = new Set(
  "black white red green blue yellow orange purple pink cyan magenta lime teal navy maroon olive aqua fuchsia silver gray grey brown gold indigo violet coral salmon tomato crimson orchid plum tan khaki turquoise lightblue lightgreen lightyellow lightgrey lightgray darkred darkgreen darkblue darkorange hotpink skyblue steelblue seagreen chocolate beige ivory lavender transparent".split(" "),
);

/** A colour value that's only a colour: hex, rgb()/rgba(), hsl()/hsla(), or a colour name. */
export function safeColour(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/+-]+\)$/.test(s)) return s;
  if (NAMED_COLOURS.has(s)) return s;
  return null;
}

/** Which palette colour a value is, if any (so it can be drawn with its theme-aware shade). */
function paletteName(v: string, kind: "text" | "highlight"): ColourName | null {
  const s = v.toLowerCase();
  const hit = PALETTE.find((p) => p[kind].toLowerCase() === s);
  if (hit) return hit.name;
  if (kind === "highlight" && EXTRA_HIGHLIGHTS[s]) return EXTRA_HIGHLIGHTS[s]!;
  return null;
}

/** What a coloured element may keep: classes for palette colours, a style for anything else. */
export function colourOf(tag: string, attrs: { style?: string | null; color?: string | null; class?: string | null }): { classes: string[]; style: string } {
  const classes: string[] = [];
  const keep: string[] = [];
  const t = tag.toLowerCase();
  if (t !== "span" && t !== "mark" && t !== "font") return { classes, style: "" };
  const add = (kind: "text" | "highlight", value: string | null | undefined) => {
    const c = value && safeColour(value);
    if (!c) return;
    const name = paletteName(c, kind);
    if (name) classes.push(kind === "text" ? `tc-${name}` : `hl-${name}`);
    else keep.push(kind === "text" ? `color: ${c}` : `background-color: ${c}`);
  };
  for (const decl of (attrs.style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (prop === "color") add("text", value);
    else if (prop === "background" || prop === "background-color") add("highlight", value);
  }
  if (t === "font") add("text", attrs.color);
  // Highlightr's class mode: hltr-red and friends.
  for (const cls of (attrs.class ?? "").split(/\s+/)) {
    const m = /^hltr-([a-z]+)$/.exec(cls);
    if (m && NAMES.has(m[1] as ColourName)) classes.push(`hl-${m[1]}`);
  }
  return { classes: [...new Set(classes)], style: keep.join("; ") };
}

/** Hilo's `=={red}text==`: the colour name, if the highlight starts with one. */
export function hiloColour(inner: string): { name: ColourName; text: string } | null {
  const m = /^\{([a-z]+)\}([\s\S]*)$/i.exec(inner);
  if (!m || !NAMES.has(m[1]!.toLowerCase() as ColourName)) return null;
  return { name: m[1]!.toLowerCase() as ColourName, text: m[2]! };
}

/** The markup Commonplace writes around text. */
export function wrapColour(text: string, kind: "text" | "highlight", name: ColourName): string {
  const p = PALETTE.find((x) => x.name === name)!;
  return kind === "highlight" ? `<mark style="background: ${p.highlight};">${text}</mark>` : `<span style="color: ${p.text};">${text}</span>`;
}

/** Colour tags around or inside some text, matched so they can be removed. */
export const COLOUR_TAG = /<(mark|span|font)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/** Text with its colour markup taken off (only colour: other HTML stays). */
export function stripColour(text: string): string {
  let out = text.replace(COLOUR_TAG, (m, tag: string, inner: string) => {
    const open = /^<[^>]*>/.exec(m)![0];
    const isColour = /\b(style|color|class)\s*=/.test(open) && (tag.toLowerCase() !== "span" || /(color|background)/i.test(open) || /hltr-/.test(open));
    return isColour || tag.toLowerCase() === "mark" ? inner : m;
  });
  out = out.replace(/==\{[a-z]+\}([\s\S]*?)==/gi, "$1");
  return out;
}
