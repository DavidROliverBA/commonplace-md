// The standalone HTML file (standalone/): builds it, serves it, and drives it in Chrome against a
// folder in the browser's private file system (standing in for a folder picked from disk), then
// with files picked the way Safari and Firefox open them. Needs no database.
// Run: bun test --timeout 30000 ./test/ui/standalone.ui.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { chromePath } from "./chrome";

const ROOT = join(import.meta.dir, "..", "..");
const PORT = 3480;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

const FILES: Record<string, string> = {
  "Welcome.md": "# Welcome\n\nSee [[Projects/Plan]] and [[Ideas]]. #start\n\n![[attachments/dot.svg]]\n",
  "Projects/Plan.md": "---\nstatus: active\n---\n# Plan\n\n- [ ] first step\n\nBack to [[Welcome]].\n",
  "attachments/dot.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>',
};

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", join(ROOT, "standalone", "build.ts")]);
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  const html = Bun.file(join(ROOT, "standalone", "dist", "commonplace.html"));
  server = Bun.serve({ port: PORT, fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

/** Fill the private file system with FILES and make the folder picker return it. */
async function freshFolder(p: Page) {
  await p.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      let d = root;
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    (window as any).showDirectoryPicker = async () => root;
  }, FILES);
}

const readFile = (p: Page, path: string) =>
  p.evaluate(async (path) => {
    const parts = path.split("/");
    let d = await navigator.storage.getDirectory();
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    return (await (await d.getFileHandle(parts.at(-1)!)).getFile()).text();
  }, path);

const clickText = (p: Page, selector: string, text: string) =>
  p.evaluate(
    (selector, text) => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim().includes(text));
      if (!el) throw new Error(`No ${selector} with ${text}`);
      el.click();
    },
    selector,
    text,
  );

describe("standalone, with a folder", () => {
  beforeAll(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".login-card");
    await freshFolder(page);
    await clickText(page, ".login-card button", "Open a folder");
    await page.waitForSelector(".sidebar .tree-row.note");
  });

  test("lists the notes and opens one", async () => {
    // The last changed note opens, with its folder.
    const rows = await page.$$eval(".tree-row", (r) => r.map((x) => x.textContent?.trim()));
    expect(rows).toContain("Projects");
    expect(rows).toContain("Welcome");
    await clickText(page, ".tree-row.note", "Welcome");
    await page.waitForSelector(".note-title");
    expect(await page.$eval(".note-title", (e) => e.textContent)).toBe("Welcome");
  });

  test("Live Preview shows the image from the folder", async () => {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".cm-content img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0));
  });

  test("a wikilink opens its note, and backlinks show", async () => {
    await page.click(".cm-lp-link[data-target='Projects/Plan']");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Plan");
    const backlinks = await page.$$eval(".right-panel .link-list button", (b) => b.map((x) => x.textContent));
    expect(backlinks).toContain("Welcome");
  });

  test("typing is written to the file", async () => {
    await page.click(".cm-content");
    await page.keyboard.down("Meta");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Meta");
    await page.keyboard.type("\nAdded line.");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    expect(await readFile(page, "Projects/Plan.md")).toContain("Added line.");
  });

  test("an unresolved link makes the note in the same folder", async () => {
    await clickText(page, ".tree-row.note", "Welcome");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Welcome");
    await page.click(".cm-lp-link[data-target='Ideas']");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Ideas");
    expect(await readFile(page, "Ideas.md")).toBe("");
  });

  test("reading view renders, and a task ticks in the file", async () => {
    await clickText(page, ".tree-row.note", "Plan");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Plan");
    await page.click("button[aria-label='Reading view']");
    await page.waitForSelector(".preview input.task");
    await page.click(".preview input.task");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    await page.waitForFunction(() => (document.querySelector(".preview input.task") as HTMLInputElement | null)?.checked);
    expect(await readFile(page, "Projects/Plan.md")).toContain("- [x] first step");
    await page.click("button[aria-label='Live preview']");
  });

  test("search finds text and tags", async () => {
    await clickText(page, ".tabs button", "Search");
    await page.type(".search-panel input", "#start");
    await page.waitForSelector(".search-results a");
    expect(await page.$$eval(".search-results .hit-title", (h) => h.map((x) => x.textContent))).toEqual(["Welcome"]);
    await clickText(page, ".tabs button", "Files");
  });

  test("rename moves the file", async () => {
    await page.click(".title-button");
    await page.waitForSelector(".title-input");
    await page.$eval(".title-input", (i) => ((i as HTMLInputElement).value = ""));
    await page.type(".title-input", "Roadmap");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Roadmap");
    expect(await readFile(page, "Projects/Roadmap.md")).toContain("# Plan");
    expect(await readFile(page, "Projects/Plan.md").catch(() => "gone")).toBe("gone");
  });

  test("a rename that only changes case keeps the file", async () => {
    await page.click(".title-button");
    await page.waitForSelector(".title-input");
    await page.$eval(".title-input", (i) => ((i as HTMLInputElement).value = ""));
    await page.type(".title-input", "roadmap");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "roadmap");
    expect(await readFile(page, "Projects/roadmap.md")).toContain("# Plan");
  });

  test("⌘O opens a note by name", async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("o");
    await page.keyboard.up("Meta");
    await page.waitForSelector(".switcher input");
    await page.type(".switcher input", "welc");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Welcome");
  });
});

describe("standalone, with picked files", () => {
  test("edits stay in the tab and download as a zip", async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(`http://localhost:${PORT}/`);
    await p.waitForSelector(".login-card");
    const input = (await p.$("input[type=file][accept]"))!;
    const dir = mkdtempSync(join(tmpdir(), "cp-standalone-"));
    const note = join(dir, "standalone-note.md");
    await Bun.write(note, "# Picked\n\nText.\n");
    try {
      await input.uploadFile(note);
      await p.waitForSelector(".note-title");
      expect(await p.$eval(".note-title", (e) => e.textContent)).toBe("standalone-note");
      await p.click(".cm-content");
      await p.keyboard.type("More. ");
      await p.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("1 changed"));
      // Catch the download instead of saving it: its name, and the zip's first bytes.
      await p.evaluate(() => {
        HTMLAnchorElement.prototype.click = function () {
          (window as any).downloaded = fetch(this.href)
            .then((r) => r.arrayBuffer())
            .then((b) => ({ name: this.download, magic: [...new Uint8Array(b).slice(0, 2)] }));
        };
      });
      await p.click(".standalone-foot button");
      expect(await p.evaluate(() => (window as any).downloaded)).toEqual({ name: "Files changes.zip", magic: [0x50, 0x4b] });
      await p.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("No unsaved changes"));
    } finally {
      await Bun.file(note).delete();
      await p.close();
    }
  });
});
