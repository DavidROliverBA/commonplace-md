// Stands in for web/lib/mermaidLib.ts: the file carries Mermaid's browser build gzipped in a
// <script type="application/octet-stream" id="mermaid-lib"> (standalone/build.ts), unpacked and
// run the first time a note has a diagram.

import { gunzipSync, strFromU8 } from "fflate";

export async function loadMermaidLib(): Promise<unknown> {
  const packed = document.getElementById("mermaid-lib")?.textContent?.trim();
  if (!packed) throw new Error("This copy has no Mermaid");
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  // As a classic script: its top-level `var` must be global, which strict-mode eval won't do.
  const script = document.createElement("script");
  script.textContent = strFromU8(gunzipSync(bytes));
  document.head.append(script);
  return (window as any).mermaid;
}
