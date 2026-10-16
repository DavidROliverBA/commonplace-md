// Mermaid's own browser build, served by the app (src/server.ts) rather than bundled, so the
// app's script stays small and Mermaid loads only for a note with a diagram. The standalone file
// swaps this module for standalone/mermaid-lib.ts, which unpacks the copy inside it.

export function loadMermaidLib(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/mermaid.js";
    s.onload = () => ((window as any).mermaid ? resolve((window as any).mermaid) : reject(new Error("Mermaid didn't start")));
    s.onerror = () => {
      s.remove();
      reject(new Error("Mermaid couldn't be fetched"));
    };
    document.head.append(s);
  });
}
