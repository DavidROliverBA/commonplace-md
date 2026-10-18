// Temporary, for finding why holding delete stops on the iPhone: `?cm-off=lp,collab` in the
// address turns those parts of the editor off for this tab (sessionStorage, so it survives moving
// between notes); `?cm-off=` turns them back on. Names are in Editor.tsx. Remove once found.

import type { Extension } from "@codemirror/state";

const OFF: Set<string> = (() => {
  try {
    const q = new URLSearchParams(location.search).get("cm-off");
    if (q !== null) sessionStorage.setItem("cm-off", q);
    return new Set((sessionStorage.getItem("cm-off") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set<string>();
  }
})();

export const isOff = (name: string) => OFF.has(name) || (OFF.has("all") && name !== "collab");

/** `ext`, unless `name` is turned off. */
export const unlessOff = (name: string, ext: Extension): Extension => (isOff(name) ? [] : ext);

export const offList = () => [...OFF];

// `?cm-off=trace` shows a readout at the top of the screen of what happens while a key is held:
// keys, the visual viewport's events, writes of --vvh and anything that scrolls.
const lines: string[] = [];
let panel: HTMLElement | null = null;
let t0 = 0;
let lastKind = "";
let runs = 1;
export function trace(line: string) {
  if (!OFF.has("trace")) return;
  if (!panel) {
    panel = document.createElement("pre");
    Object.assign(panel.style, {
      position: "fixed", top: "env(safe-area-inset-top)", left: "0", right: "0", zIndex: "99999", margin: "0",
      padding: "4px 6px", font: "10px/1.3 ui-monospace, monospace", background: "rgba(0,0,0,0.78)", color: "#fff",
      pointerEvents: "none", whiteSpace: "pre-wrap", maxHeight: "9.5em", overflow: "hidden",
    });
    document.body.append(panel);
    t0 = performance.now();
  }
  // A run of the same kind of event (scrolling, a held key) takes one line, with a count.
  const at = String(Math.round(performance.now() - t0)).padStart(6);
  const kind = line.replace(/ -?\d+$/, "");
  if (lastKind === kind && lines.length) lines[0] = `${at} ${line} ×${++runs}`;
  else {
    lastKind = kind;
    runs = 1;
    lines.unshift(`${at} ${line}`);
  }
  lines.length = Math.min(lines.length, 7);
  panel.textContent = lines.join("\n");
}

if (OFF.has("trace")) {
  const name = (t: EventTarget | null) =>
    t === document ? "page" : t instanceof Element ? (t.className && typeof t.className === "string" ? t.className.split(" ")[0] : t.tagName.toLowerCase()) : "?";
  // One line per press: how long since the last, and the note's length after it.
  let last = 0;
  let presses = 0;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace" || !e.isTrusted) return;
    const now = performance.now();
    if (now - last > 700) presses = 0;
    const gap = Math.round(now - last);
    last = now;
    presses++;
    setTimeout(() => trace(`press ${presses}${e.repeat ? " repeat" : ""} +${gap}ms note ${document.querySelector(".cm-content")?.textContent?.length ?? "?"} chars`), 120);
  }, true);
  window.addEventListener("beforeinput", (e) => trace(`input ${(e as InputEvent).inputType}`), true);
  window.addEventListener("focusout", (e) => trace(`blur ${name(e.target)}`), true);
}
