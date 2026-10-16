// Builds Commonplace as one self-contained HTML file: `bun standalone/build.ts`.
// Bundles standalone/main.tsx (which reuses the app's editor, renderer, dialogs and styles),
// swaps web/lib/api.ts for a stand-in that reads the open folder, and inlines the script and
// stylesheet (and Mermaid, packed) so the file works from disk with no server.

import { gzipSync } from "fflate";
import { dataviewjsSandbox } from "../src/sandbox";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const out = join(here, "dist", "commonplace.html");
const shim = join(here, "api-shim.ts");
const mermaidShim = join(here, "mermaid-lib.ts");
const pkg = await Bun.file(join(here, "..", "package.json")).json();

const result = await Bun.build({
  entrypoints: [join(here, "main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "local-api",
      setup(b) {
        // Every `./api` (or `../lib/api`) import in the shared client code resolves to the shim.
        b.onResolve({ filter: /(^|\/)api(\.ts)?$/ }, (args) => {
          const target = join(dirname(args.importer), args.path).replace(/\.ts$/, "");
          return target.endsWith(join("web", "lib", "api")) ? { path: shim } : undefined;
        });
        // Mermaid comes from inside the file, not the server.
        b.onResolve({ filter: /(^|\/)mermaidLib(\.ts)?$/ }, () => ({ path: mermaidShim }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

let js = "";
let css = "";
for (const o of result.outputs) {
  if (o.path.endsWith(".js")) js += await o.text();
  else if (o.path.endsWith(".css")) css += await o.text();
}
// Nothing in the inlined code may close its own tag early.
const safe = (s: string, tag: string) => s.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

// Mermaid's browser build, gzipped: unpacked only when a note has a diagram (standalone/mermaid-lib.ts).
const mermaidJs = await Bun.file(join(dirname(Bun.resolveSync("mermaid/package.json", here)), "dist", "mermaid.min.js")).bytes();
const mermaidPacked = Buffer.from(gzipSync(mermaidJs, { level: 9 })).toString("base64");

// The dataviewjs sandbox page (src/sandbox.ts), shown in its frames with srcdoc.
const sandboxPacked = Buffer.from(gzipSync(new TextEncoder().encode((await dataviewjsSandbox()).html), { level: 9 })).toString("base64");

const icon = await Bun.file(join(here, "..", "web", "icon.svg")).text();
const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="generator" content="Commonplace ${pkg.version} standalone">
<title>Commonplace</title>
<meta name="description" content="A Markdown editor for a folder of notes, in one file.">
<meta name="theme-color" content="#f7f6fb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1b22" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">
<style>${safe(css, "style")}</style>
</head>
<body>
<div id="root"></div>
<script type="application/octet-stream" id="mermaid-lib">${mermaidPacked}</script>
<script type="application/octet-stream" id="dvjs-sandbox">${sandboxPacked}</script>
<script type="module">${safe(js, "script")}</script>
</body>
</html>
`;
await Bun.write(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
