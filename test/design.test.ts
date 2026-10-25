// The design language, checked (docs/PRINCIPLES.md §2). Fails when a change slips in a browser
// dialog, a raw colour or type size outside the tokens, or a stylesheet that isn't loaded. Reads
// the files in web/; needs nothing else.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "../web");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
}
const rel = (f: string) => f.slice(WEB.length + 1);
/** Every "file:line: text" in `list` whose line matches `re`, skipping comments. */
function offenders(list: string[], re: RegExp): string[] {
  return list.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .flatMap((line, i) => (re.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line) ? [`${rel(f)}:${i + 1}: ${line.trim()}`] : [])),
  );
}

const code = files(WEB, /\.(tsx?)$/);
const styles = files(join(WEB, "styles"), /\.css$/).filter((f) => !f.endsWith("tokens.css"));

describe("design language", () => {
  test("no browser alert, confirm or prompt: use web/ui/overlays.tsx", () => {
    expect(offenders(code, /(?<![\w.])(alert|confirm|prompt)\(|window\.(alert|confirm|prompt)\b/)).toEqual([]);
  });

  test("colours come from tokens.css", () => {
    expect(offenders(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)).toEqual([]);
  });

  test("type sizes come from the scale in tokens.css (em is fine inside rendered markdown)", () => {
    expect(offenders(styles, /font(-size)?:\s*\d+(\.\d+)?px/)).toEqual([]);
  });

  test("radii come from tokens.css", () => {
    expect(offenders(styles, /border-radius:[^;]*\b[1-9]\d*px/)).toEqual([]);
  });

  test("motion uses the duration tokens, so reduced motion turns it off", () => {
    expect(offenders(styles, /(transition|animation)[^;]*\b\d+(\.\d+)?m?s\b/)).toEqual([]);
  });

  test("dark is the same whether the system chose it or someone did (Auto, Light, Dark)", () => {
    const tokens = readFileSync(join(WEB, "styles/tokens.css"), "utf8");
    const values = (block: string | undefined) => (block ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const system = /:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(tokens)?.[1];
    const chosen = /\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(tokens)?.[1];
    expect(values(system).length).toBeGreaterThan(20);
    expect(values(chosen)).toEqual(values(system));
  });

  test("every stylesheet is loaded by web/styles.css", () => {
    const manifest = readFileSync(join(WEB, "styles.css"), "utf8");
    for (const f of files(join(WEB, "styles"), /\.css$/)) expect(manifest).toContain(`./styles/${f.split("/").pop()}`);
  });
});
