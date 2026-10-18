// Zips each demo vault in demo/ (a plain folder of Markdown files) into demo/dist/<name>.zip, ready
// for Settings → Vault → Import markdown. `bun run demo`.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, relative } from "path";
import { zipSync } from "fflate";

const ROOT = join(import.meta.dir, "..", "demo");

/** Every file under a demo vault, keyed by its path inside the vault. */
export function demoFiles(name: string): Record<string, Uint8Array> {
  const dir = join(ROOT, name);
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

export const DEMOS = readdirSync(ROOT).filter((e) => e !== "dist" && statSync(join(ROOT, e)).isDirectory());

if (import.meta.main) {
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  for (const name of DEMOS) {
    const zip = zipSync(demoFiles(name));
    writeFileSync(join(ROOT, "dist", `${name}.zip`), zip);
    console.log(`demo/dist/${name}.zip  ${Object.keys(demoFiles(name)).length} files, ${(zip.byteLength / 1024).toFixed(1)} KB`);
  }
}
