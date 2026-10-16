// The page a dataviewjs block runs in (web/sandbox/dvjs.ts), built once: its script inline and
// pinned by hash, its styles inline. Served at /sandbox/dataviewjs inside a sandboxed frame with
// an opaque origin, so a note's script can't read the app's cookies, pages or storage; its policy
// allows no network at all (no fetch, images, fonts or forms from anywhere), so what it reads
// can't leave. The standalone file carries the same page and shows it with srcdoc.

import { createHash } from "node:crypto";
import { join } from "node:path";

const web = join(import.meta.dir, "..", "web");

export interface Sandbox {
  html: string;
  /** The policy, for the response header (with sandbox and frame-ancestors added there). */
  csp: string;
}

let built: Promise<Sandbox> | null = null;

export function dataviewjsSandbox(fresh = false): Promise<Sandbox> {
  if (!built || fresh) {
    built = build();
    built.catch(() => (built = null));
  }
  return built;
}

async function build(): Promise<Sandbox> {
  const r = await Bun.build({ entrypoints: [join(web, "sandbox", "dvjs.ts")], target: "browser", format: "iife", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!r.success) throw new Error(r.logs.map(String).join("\n"));
  const js = (await r.outputs.find((o) => o.path.endsWith(".js"))!.text()).replace(/<\/(script)/gi, "<\\/$1");
  const css = (await Promise.all(["tokens.css", "markdown.css", "dataview-sandbox.css"].map((f) => Bun.file(join(web, "styles", f)).text()))).join("\n").replace(/<\/(style)/gi, "<\\/$1");
  const hash = createHash("sha256").update(js).digest("base64");
  // 'unsafe-eval' is how the note's code runs (new Function), inside this frame only.
  const csp = `default-src 'none'; script-src 'sha256-${hash}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>dataviewjs</title>
<style>${css}</style>
</head>
<body class="dv-sandbox">
<div id="root" class="markdown"></div>
<script>${js}</script>
</body>
</html>
`;
  return { html, csp };
}
