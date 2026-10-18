// The help (docs/help/, web/lib/help.ts): every page is listed, every link and picture is there,
// every picture is used and made by `bun run help:shots`, and the shortcuts page lists every
// command's shortcut. Reads files only.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../web/lib/commands";
import { ALL_HELP_PAGES, HELP_PAGES } from "../web/lib/help";

const DIR = join(import.meta.dir, "..", "docs", "help");
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const images = readdirSync(join(DIR, "images"));
const page = (id: string) => ALL_HELP_PAGES.find((p) => p.id === id)!;

describe("the help", () => {
  test("lists every page in docs/help, once, starting with the index", () => {
    expect(ALL_HELP_PAGES.map((p) => `${p.id}.md`).sort()).toEqual(files.sort());
    expect(ALL_HELP_PAGES[0]!.id).toBe("index");
    expect(HELP_PAGES).toBe(ALL_HELP_PAGES); // the app's build has them all
    for (const p of ALL_HELP_PAGES) expect(p.body.trimStart().startsWith(`# ${p.title}\n`)).toBe(true);
  });

  test("the index links every other page", () => {
    const linked = [...page("index").body.matchAll(/\]\(([\w-]+)\.md\)/g)].map((m) => m[1]);
    expect(new Set(linked)).toEqual(new Set(ALL_HELP_PAGES.filter((p) => p.id !== "index").map((p) => p.id)));
  });

  test("every link goes to a page, and every picture is there and used", () => {
    const used = new Set<string>();
    for (const p of ALL_HELP_PAGES) {
      for (const [, target] of p.body.matchAll(/\]\((?!https?:)([^)\s]+)\)/g)) {
        if (target!.startsWith("images/")) {
          expect(images).toContain(target!.slice(7));
          used.add(target!.slice(7));
        } else expect(`${p.id}: ${target}`).toMatch(new RegExp(`: (${ALL_HELP_PAGES.map((q) => q.id).join("|")})\\.md$`));
      }
      // Pictures need a description for screen readers.
      expect(p.body).not.toMatch(/!\[\]\(/);
    }
    expect([...used].sort()).toEqual(images.sort());
  });

  test("every picture is made by the screenshot script", () => {
    const script = readFileSync(join(import.meta.dir, "ui", "screens.ts"), "utf8");
    for (const img of images) expect(`${img}: ${(script.includes(`"${img.replace(/\.webp$/, "")}"`) || script.includes(`"${img}"`))}`).toBe(`${img}: true`);
  });

  test("the shortcuts page lists every command's shortcut", () => {
    const text = page("shortcuts").body;
    for (const c of COMMANDS.filter((c) => c.shortcut)) expect(`${c.title}: ${text.includes(`\`${c.shortcut}\``)}`).toBe(`${c.title}: true`);
  });

  test("the standalone file has its own page and the general ones", () => {
    expect(ALL_HELP_PAGES.filter((p) => p.standalone).map((p) => p.id)).toEqual(["index", "writing", "links", "organising", "search", "queries", "standalone", "shortcuts"]);
  });
});
