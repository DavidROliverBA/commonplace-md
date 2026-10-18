// Mermaid diagrams: a ```mermaid block is drawn as a diagram, with the same syntax other Markdown
// editors use (flowcharts, sequence, class, state, ER, Gantt, pie, mindmaps, `%%{init}%%` and
// `class A internal-link` to make a node open the note it names).
//
// The renderer leaves the source in a `.mermaid-diagram` placeholder; drawDiagrams() swaps in the
// SVG. Mermaid itself (about 3 MB) loads the first time a note has a diagram. Each diagram sits in
// its own shadow root, so the stylesheet Mermaid puts in the SVG can't restyle the app, and it runs
// in strict mode (labels are escaped, no click scripts) with its output sanitised again.

import createDOMPurify from "dompurify";
import { loadMermaidLib } from "./mermaidLib";

type Mermaid = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

let lib: Promise<Mermaid> | null = null;
let configured = "";
let seq = 0;
// Its own instance: the renderer's colour hooks are for note HTML, not diagram labels.
let purify: ReturnType<typeof createDOMPurify> | null = null;

const dark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

async function mermaid(): Promise<Mermaid> {
  lib ??= loadMermaidLib() as Promise<Mermaid>;
  lib.catch(() => (lib = null));
  const m = await lib;
  const theme = dark() ? "dark" : "default";
  if (configured !== theme) {
    configured = theme;
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      // Dark's edge labels are #ccc on #585858, just short of WCAG AA (4.5:1); a darker box clears it.
      ...(theme === "dark" ? { themeVariables: { edgeLabelBackground: "#454545" } } : {}),
      fontFamily: getComputedStyle(document.body).fontFamily,
      suppressErrorRendering: true,
      // A note's %%{init}%% may change the look, but not add CSS of its own.
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "themeCSS", "fontFamily"],
    });
  }
  return m;
}

const SHADOW_CSS = `:host{display:block}svg{max-width:100%;height:auto}.internal-link{cursor:pointer}
.error{font-family:var(--mono);font-size:var(--text-ui-sm);color:var(--danger);white-space:pre-wrap;text-align:left;margin:0}`;

// Drawn diagrams by theme and source, so the preview redrawing as someone types doesn't flicker.
const drawn = new Map<string, Promise<{ svg: string } | { error: string }>>();

async function svgFor(source: string): Promise<{ svg: string } | { error: string }> {
  const m = await mermaid();
  const key = `${configured}\n${source}`;
  let p = drawn.get(key);
  if (!p) {
    p = m.render(`cp-mermaid-${++seq}`, source).then(
      ({ svg }) => {
        purify ??= createDOMPurify(window);
        return {
          svg: purify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true, html: true },
            ADD_TAGS: ["foreignObject", "style"],
            HTML_INTEGRATION_POINTS: { foreignobject: true },
          }),
        };
      },
      (e) => ({ error: String((e as Error)?.message ?? e) }),
    );
    drawn.set(key, p);
    if (drawn.size > 60) drawn.delete(drawn.keys().next().value!);
  }
  return p;
}

/** Draw one diagram into `box` (a `.mermaid-diagram`, whose <code> holds the source). The source
 *  shows until the diagram is ready, and under the message if it can't be drawn. */
async function draw(box: HTMLElement, onOpen?: (target: string) => void): Promise<void> {
  let out: { svg: string } | { error: string };
  try {
    out = await svgFor(box.textContent ?? "");
  } catch (e) {
    out = { error: `Mermaid didn't load: ${(e as Error)?.message ?? e}` };
  }
  const root = box.shadowRoot ?? box.attachShadow({ mode: "open" });
  if ("error" in out) {
    root.innerHTML = `<style>${SHADOW_CSS}</style><pre class="error"></pre><slot></slot>`;
    root.querySelector(".error")!.textContent = `Diagram error: ${out.error}`;
    box.classList.add("mermaid-failed");
    return;
  }
  root.innerHTML = `<style>${SHADOW_CSS}</style>${out.svg}`;
  box.classList.remove("mermaid-failed");
  // `class A internal-link`: the node opens the note named by its label.
  if (onOpen) {
    for (const node of root.querySelectorAll<SVGElement>(".node.internal-link")) {
      node.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const name = node.textContent?.trim();
        if (name) onOpen(name);
      });
    }
  }
}

/** Draw every diagram not yet drawn under `root`. */
export function drawDiagrams(root: ParentNode, onOpen?: (target: string) => void): void {
  for (const box of root.querySelectorAll<HTMLElement>(".mermaid-diagram:not([data-done])")) {
    box.dataset.done = "1";
    void draw(box, onOpen).then(() => box.dispatchEvent(new Event("cp-diagram", { bubbles: true })));
  }
}

/** Placeholder HTML for a diagram's source (escaped), as the renderer emits it. */
export function diagramHtml(source: string, esc: (s: string) => string): string {
  return `<div class="mermaid-diagram" role="img" aria-label="Diagram"><pre><code>${esc(source)}</code></pre></div>`;
}

// Light ↔ dark: draw the diagrams on screen again in the other theme.
if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    for (const box of document.querySelectorAll<HTMLElement>(".mermaid-diagram[data-done]")) void draw(box);
  });
}
