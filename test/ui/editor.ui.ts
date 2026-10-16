// Browser tests: headless Chromium against a real server and a scratch database. Not part of
// `bun test` (they need Chrome); run with `bun run test:ui`. Chrome is found from CHROME_PATH, a
// Playwright download, or an installed Google Chrome (test/ui/chrome.ts). Needs the docker
// database (`docker compose up -d db`): each run drops and recreates `commonplace_ui` on it
// (UI_ADMIN_DATABASE_URL names the admin connection).
//
// Covers what unit and API tests can't: Live Preview rendering and reveal-on-cursor, task and
// table widgets, properties, the picture picker's resizing, folders, drag and drop (mouse and
// long-press touch), Trash, the / menu and ⌘K, the block handle, GitHub vaults, templates,
// Settings, the AI panel, types, embeds, offline on the iPhone, accessibility (axe), published
// sites, keyboard-only use, and live co-editing between two pages. Debug switches: UI_DEBUG=1
// prints page errors, UI_WATCHDOG=1 reports frozen pages, A11Y_REPORT=1 prints every axe finding.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// bun test runs on UTC; the server and the pages work in London time, so "today" must match theirs.
process.env.TZ = "Europe/London";
import postgres from "postgres";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startFakeAi } from "../fakeAi";
import { startFakeGitHub, TOKEN } from "../fakeGitHub";
import { chromePath } from "./chrome";
import { addDays, dailyPath, formatDate } from "../../web/lib/templates";

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const ADMIN_DB = process.env.UI_ADMIN_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB = ADMIN_DB.replace(/\/[^/]+$/, "/commonplace_ui");

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;
let cookie = "";
let vaultId = 0;
const errors: string[] = [];
/** While the offline test has the server stopped, failed requests are expected, not bugs. */
let serverDown = false;

async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(`${BASE}/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const note = (path: string, content = "") => api(`/vaults/${vaultId}/notes`, { path, content });
const paths = async () => ((await api(`/vaults/${vaultId}/notes`)) as { path: string }[]).map((n) => n.path).sort();

/** Pages opened in this browser. Headless Chrome stops painting (and so taking clicks) after
 *  forty-odd pages in one run (2026-10-11), so start a fresh one every so often, between tests. */
let opened = 0;
const launch = () => puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

/** At the start of each group of tests (their browser state, such as open folders, carries from
 *  one test to the next within a group): a fresh browser if this one has opened enough pages. */
async function freshBrowser() {
  if (opened < 15) return;
  await browser.close();
  browser = await launch();
  opened = 0;
}

async function open(url: string, phone = false): Promise<Page> {
  opened++;
  const page = await browser.newPage();
  await page.emulateTimezone("Europe/London"); // the server's TIME_ZONE and the tests' clock (headless Chrome may run on UTC)
  page.setDefaultTimeout(10000); // fail with a message well inside the 30 s test timeout
  await page.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1200, height: 850 });
  page.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
  page.on("console", (m) => m.type() === "error" && !serverDown && errors.push(m.text()));
  // The app has its own dialogs (web/ui/overlays.tsx); a browser one is a bug.
  page.on("dialog", (d) => (errors.push(`browser ${d.type()} dialog: ${d.message()}`), void d.dismiss()));
  await page.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
  if (process.env.UI_WATCHDOG) watchdog(page);
  await page.goto(`${BASE}${url}`, { waitUntil: "load" });
  await page.bringToFront(); // headless Chrome holds back input to a tab that isn't in front
  return page;
}
/** Debugging aid (UI_WATCHDOG=1): report a page that stops answering, with its stack. */
function watchdog(page: Page) {
  let reported = false;
  const t = setInterval(async () => {
    if (page.isClosed()) return clearInterval(t);
    const ok = await Promise.race([page.evaluate(() => true).catch((e) => `error: ${e}`), Bun.sleep(5000).then(() => false)]);
    if (ok === true || reported || page.isClosed()) return;
    if (typeof ok === "string") console.log("WATCHDOG evaluate failed:", page.url(), ok.slice(0, 200));
    reported = true;
    console.log("WATCHDOG frozen page:", page.url());
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Debugger.enable");
      const paused = new Promise<any>((res) => cdp.once("Debugger.paused", res));
      await cdp.send("Debugger.pause");
      const ev = await Promise.race([paused, Bun.sleep(3000).then(() => null)]);
      console.log("WATCHDOG stack:", ev ? ev.callFrames.slice(0, 30).map((f: any) => `${f.functionName || "anon"}:${f.location.lineNumber + 1}`).join(" < ") : "no pause");
      if (ev) {
        for (const f of ev.callFrames.slice(0, 3)) {
          const src = (await cdp.send("Debugger.getScriptSource", { scriptId: f.location.scriptId })).scriptSource.split("\n");
          console.log(`WATCHDOG ${f.functionName}:${f.location.lineNumber + 1}\n` + src.slice(f.location.lineNumber - 4, f.location.lineNumber + 2).map((l: string) => "   | " + l.slice(0, 160)).join("\n"));
        }
      }
    } catch (e) {
      console.log("WATCHDOG couldn't pause:", String(e));
    }
  }, 2000);
}

const openNote = async (id: number, phone = false) => {
  const page = await open(`/v/${vaultId}/n/${id}`, phone);
  await page.waitForSelector(".cm-content");
  await page.waitForSelector(".note-body[data-synced]", { timeout: 10_000 }); // live sync
  return page;
};
const content = (p: Page) => p.$eval(".cm-content", (e) => e.textContent ?? "");
async function until(fn: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}
/** Fill in the app's prompt dialog and press its action button. */
async function answer(p: Page, text: string) {
  const input = await p.waitForSelector("[data-dialog-input]");
  await input!.evaluate((e) => (e as HTMLInputElement).select());
  await p.keyboard.type(text);
  await p.click("[data-dialog-action]");
  await p.waitForSelector("[data-dialog-input]", { hidden: true });
}
/** Open a folder row's ⋯ menu and choose an item. */
async function folderAction(p: Page, folder: string, item: string) {
  const at = await rowCenter(p, folder);
  await p.mouse.move(at.x, at.y); // the row's buttons show on hover
  await p.click(`button[aria-label="${folder} folder actions"]`);
  await p.waitForSelector(".menu-item");
  await p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes(t))!.click(), item);
}
const clickToast = (p: Page, label: string) =>
  p.waitForSelector(".toast-action").then(() => p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].find((b) => b.textContent === t)!.click(), label));

async function rowCenter(p: Page, label: string, scroll = true) {
  const h = await p.evaluateHandle(
    (t) => [...document.querySelectorAll(".tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t),
    label,
  );
  if (scroll) {
    await (h as any).evaluate((e: Element) => e.scrollIntoView({ block: "nearest" })); // as a person would scroll to it
    await Bun.sleep(50);
  }
  const b = await (h as any).boundingBox();
  if (!b) throw new Error(`no tree row ${label}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

beforeAll(async () => {
  const admin = postgres(ADMIN_DB, { onnotice: () => {} });
  await admin.unsafe("drop database if exists commonplace_ui with (force)");
  await admin.unsafe("create database commonplace_ui");
  await admin.end();
  server = startServer();
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok ?? false, 20000);
  return afterStart();
}, 60000);

function startServer() {
  return Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), ALLOW_SIGNUP: "true", SETUP_TOKEN: "", EMBEDDING_PROVIDER: "hash", SECRETS_KEY: "ui-secrets-key", ALLOW_LOCAL_AI: "true", WEBLINKS_ALLOW_LOCAL: "true", GITHUB_API_URL: "http://localhost:3286", NODE_ENV: process.env.UI_NODE_ENV ?? "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function afterStart() {
  const r = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "ui@example.com", password: "password-ui", name: "Ui" }),
  });
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  vaultId = (await api("/vaults"))[0].id;
  browser = await launch();
}

afterAll(async () => {
  if (process.env.UI_DEBUG) console.log("page errors:", errors);
  await browser?.close();
  server?.kill();
});

describe("live preview", () => {
  beforeAll(freshBrowser);
  let id = 0;
  test("renders markdown in place and reveals the cursor's line", async () => {
    await note("Contractors.md", "# Contractors");
    id = (
      await note(
        "Kitchen.md",
        "# Kitchen\n\nAt [[Contractors|our builders]] and [[Missing]]. **Bold**, *it*, ~~gone~~, `code`, ==hi== and [a link](https://example.com).\n\n> [!tip] Decision\n> Quartz.\n\n## Tasks\n- [x] Quotes\n- [ ] Tiles\n- Plain\n\n---\n\nEnd",
      )
    ).id;
    const p = await openNote(id);
    const text = await content(p);
    expect(text).toContain("At our builders and Missing. Bold, it, gone, code, hi and a link.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("[[");
    expect(await p.$$eval(".cm-lp-task", (b) => b.length)).toBe(2);
    expect(await p.$(".cm-lp-callout-title")).not.toBeNull();
    // Clicking a line shows its markdown.
    const tasks = (await rowOfLine(p, "Tasks"))!;
    await p.mouse.click(tasks.x + tasks.width - 4, tasks.y + tasks.height / 2);
    await until(async () => (await lineText(p, "Tasks")) === "## Tasks");
    await p.close();
  });

  test("ticking a checkbox edits the markdown", async () => {
    const p = await openNote(id);
    const boxes = await p.$$(".cm-lp-task");
    await boxes[1]!.click();
    await until(async () => (await api(`/vaults/${vaultId}/notes/${id}`)).content.includes("- [x] Tiles"));
    await p.close();
  });

  test("clicking a wikilink opens the note; Source mode shows raw markdown", async () => {
    const p = await openNote(id);
    await p.click(".cm-lp-wikilink:not(.cm-lp-unresolved)");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent)) === "Contractors");
    await p.goto(`${BASE}/v/${vaultId}/n/${id}`, { waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await p.click('.segmented button[title="Source mode"]');
    await until(async () => (await content(p)).includes("[[Contractors|our builders]]"));
    await p.click('.segmented button[title="Live preview"]');
    await p.close();
  });

  test("frontmatter is a properties table and tables render; the table's Markdown button reveals the source", async () => {
    const t = await note("Budget.md", "---\ntags: [home]\nstatus: open\n---\n# Budget\n\n| Item | Cost |\n|---|---:|\n| Units | **£7,500** |\n\nAfter");
    const p = await openNote(t.id);
    expect(await p.$eval('.prop-row[data-key="status"] .prop-input', (e) => (e as HTMLInputElement).value)).toBe("open");
    expect(await p.$$eval(".cm-lp-table table", (t) => t.length)).toBe(1);
    expect(await p.$eval(".cm-lp-table td:last-child strong", (e) => e.textContent)).toBe("£7,500");
    await p.click(".cm-lp-table td");
    await p.waitForSelector(".table-bar", { visible: true });
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.textContent?.includes("Markdown"))!.click());
    await until(async () => (await content(p)).includes("|---|---:|"));
    expect(await p.$(".cm-lp-properties")).not.toBeNull(); // only the touched block reveals
    await p.close();
  });

  test("tables edit cell by cell: type, Tab across, Tab at the end adds a row, the bar adds a column; pipes line up", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const t = await note("Quotes.md", "# Quotes\n\n| Firm | Price |\n|---|---:|\n| Acme | 100 |\n\nAfter\n");
    const p = await openNote(t.id);
    await p.waitForSelector(".cm-table-edit td");
    await p.click('.cm-table-edit td[data-r="0"][data-c="0"]');
    await p.keyboard.down("Meta");
    await p.keyboard.press("a");
    await p.keyboard.up("Meta");
    await p.keyboard.type("Acme Tiles");
    await p.keyboard.press("Tab"); // to Price
    await p.keyboard.press("Tab"); // the last cell: a new row
    await p.keyboard.type("Brick & Co");
    await p.keyboard.press("Tab");
    await p.keyboard.type("95");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.textContent?.includes("Column right"))!.click());
    await p.keyboard.type("Notes");
    await p.keyboard.press("Escape");
    await until(async () => (await raw(t.id)).includes("| Brick & Co |    95 | Notes |"), 8000);
    expect(await raw(t.id)).toBe("# Quotes\n\n| Firm       | Price |       |\n| ---------- | ----: | ----- |\n| Acme Tiles |   100 |       |\n| Brick & Co |    95 | Notes |\n\nAfter\n");
    // One undo takes back the last change only.
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("z");
    await p.keyboard.up("Meta");
    await until(async () => !(await raw(t.id)).includes("Notes"), 8000);
    await p.close();
  });

  test("colours: every plugin's form shows; only a safe colour survives the sanitiser", async () => {
    const md = [
      "# Colours",
      "",
      '<mark style="background: #FFF3A3A6;">highlightr</mark> <mark class="hltr-blue">classes</mark> <font color="#ff0000">font</font> =={green}hilo==',
      "",
      '<span style="color: #123456; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: url(https://x.invalid/a.png)">evil</span>',
      "",
      '<div style="position: fixed; inset: 0; background: red">overlay</div>',
    ].join("\n");
    const n = await note("Colours.md", md);
    const p = await openNote(n.id);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview mark.hl-yellow");
    expect(await p.$eval(".preview mark.hl-blue", (e) => e.textContent)).toBe("classes");
    expect(await p.$eval(".preview mark.hl-green", (e) => e.textContent)).toBe("hilo");
    expect(await p.$eval(".preview font", (e) => getComputedStyle(e).color)).toBe("rgb(255, 0, 0)");
    const evil = await p.evaluate(() => {
      const s = [...document.querySelectorAll(".preview span")].find((e) => e.textContent === "evil")!;
      return { style: s.getAttribute("style"), position: getComputedStyle(s).position };
    });
    expect(evil).toEqual({ style: "color: #123456", position: "static" });
    expect(await p.evaluate(() => [...document.querySelectorAll(".preview [style]")].every((e) => /^(color|background-color): [^;]+$/.test(e.getAttribute("style")!)))).toBe(true);
    // Live Preview shows the colours too, with the tags hidden off the cursor's line.
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Live preview"]')!.click());
    await p.waitForSelector(".cm-lp-colour.hl-yellow");
    expect(await content(p)).not.toContain("<mark");
    await p.close();
  });

  test("colouring from the editor writes the portable HTML markup, and Remove colour takes it off", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const n = await note("Paint.md", "# Paint\n\nChoose tiles soon\n");
    const p = await openNote(n.id);
    await p.evaluate(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Choose tiles soon")!;
      const t = line.firstChild!;
      const r = document.createRange();
      r.setStart(t, 7);
      r.setEnd(t, 12);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    });
    await Bun.sleep(100);
    await p.keyboard.down("Meta");
    await p.keyboard.down("Shift");
    await p.keyboard.press("h");
    await p.keyboard.up("Shift");
    await p.keyboard.up("Meta");
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("yellow highlight");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes('Choose <mark style="background: #FFF3A3A6;">tiles</mark> soon'), 8000);
    await p.keyboard.down("Meta");
    await p.keyboard.down("Shift");
    await p.keyboard.press("h");
    await p.keyboard.up("Shift");
    await p.keyboard.up("Meta");
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("remove");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes("Choose tiles soon"), 8000);
    await p.close();
  });

  test("mermaid blocks draw as diagrams, in Live Preview and reading view, and can't restyle the app", async () => {
    await note("Builders.md", "# Builders\n");
    const md = [
      "# Flow",
      "",
      "```mermaid",
      "%%{init: {'themeCSS': 'body, .app { display: none !important; }'}}%%",
      "flowchart LR",
      "  A[Quote] --> B[Builders]",
      "  class B internal-link",
      "```",
      "",
      "Below.",
    ].join("\n");
    const n = await note("Flow.md", md);
    const p = await openNote(n.id);
    const drawn = (sel: string) => p.waitForFunction((sel) => !!document.querySelector(sel)?.shadowRoot?.querySelector("svg .node"), { timeout: 15000 }, sel);
    await drawn(".cm-content .mermaid-diagram");
    expect(await p.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await drawn(".preview .mermaid-diagram");
    await p.evaluate(() => {
      const node = document.querySelector(".preview .mermaid-diagram")!.shadowRoot!.querySelector<SVGElement>(".node.internal-link")!;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Builders");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("Dataview: results in Live Preview and reading view, ticking a task in its own note, and refreshing", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const t = await note("DV/Tasks One.md", "---\nstatus: active\npriority: 2\n---\n# Tasks One\n\n- [ ] Call the plumber\n");
    await note("DV/Tasks Two.md", "---\nstatus: paused\npriority: 1\n---\n# Tasks Two\n");
    const board = await note(
      "DV Board.md",
      '# DV Board\n\nActive: `= length(filter(dv.pages("DV"), (p) => p.status = "active"))`\n\n```dataview\nTABLE status AS "Status" FROM "DV" SORT priority ASC\n```\n\n```dataview\nTASK FROM "DV" WHERE !completed\n```\n',
    );
    const p = await openNote(board.id);
    await p.waitForFunction(() => document.querySelectorAll(".cm-content .dataview-block table tbody tr").length === 2, { timeout: 8000 });
    expect(await p.$$eval(".cm-content .dataview-block table tbody tr", (r) => r.map((x) => x.textContent))).toEqual(["Tasks Twopaused", "Tasks Oneactive"]);
    expect(await p.$eval(".cm-content .dataview-inline", (e) => e.textContent)).toBe("1");
    await p.click(".cm-content input.dv-task");
    await until(async () => (await raw(t.id)).includes("- [x] Call the plumber"), 8000);
    await p.waitForFunction(() => document.querySelector(".cm-content .dataview-block .dv-empty")?.textContent === "No tasks.", { timeout: 8000 });
    // Another note changing shows without reopening this one.
    await api(`/vaults/${vaultId}/notes/${t.id}/content`, { content: (await raw(t.id)).replace("status: active", "status: paused") }, "PUT");
    await p.waitForFunction(() => document.querySelector(".cm-content .dataview-inline")?.textContent === "0", { timeout: 10000 });
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForFunction(() => document.querySelectorAll(".preview .dataview-block table tbody tr").length === 2, { timeout: 8000 });
    await p.click(".preview .dataview-block table a.internal-link");
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Tasks Two");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("the outline shows headings as plain text", async () => {
    const t = await note("Outline.md", "# Plan **now**\n\n## See [[Contractors|builders]]");
    const p = await openNote(t.id);
    const outline = await p.$$eval(".right-panel li, .outline li", (els) => els.map((e) => e.textContent?.trim()));
    expect(outline).toContain("Plan now");
    expect(outline).toContain("See builders");
    await p.close();
  });
});

describe("properties", () => {
  beforeAll(freshBrowser);
  const fm = (id: number) => api(`/vaults/${vaultId}/notes/${id}`).then((n) => n.content.split("\n---")[0] as string);
  async function setInput(p: Page, sel: string, value: string) {
    await p.click(sel);
    expect(await p.$eval(sel, (e) => e === document.activeElement)).toBe(true); // one click focuses it
    await p.$eval(sel, (e) => (e as HTMLInputElement).select()); // Puppeteer's ⌘A doesn't select in inputs
    await p.keyboard.press("Backspace");
    await p.keyboard.type(value);
    await p.keyboard.press("Enter");
  }

  test("edit text, number, checkbox and date values in place; other lines are untouched", async () => {
    const n = await note("Props.md", '---\ntags: [home]   # kept\nstatus: open\nbudget: 100\ndone: false\ndue: 2026-10-10\n"my key": x\n---\n# Props');
    const p = await openNote(n.id);
    await setInput(p, '.prop-row[data-key="status"] .prop-input', "in progress");
    await until(async () => (await fm(n.id)).includes("status: in progress"));
    await setInput(p, '.prop-row[data-key="budget"] .prop-input', "250");
    await until(async () => (await fm(n.id)).includes("budget: 250"));
    await p.click('.prop-row[data-key="done"] .prop-check');
    await until(async () => (await fm(n.id)).includes("done: true"));
    await p.$eval('.prop-row[data-key="due"] .prop-input', (e) => {
      (e as HTMLInputElement).value = "2026-12-25";
      e.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(async () => (await fm(n.id)).includes("due: 2026-12-25"));
    const text = await fm(n.id);
    expect(text).toContain("tags: [home]   # kept");
    expect(text).toContain('"my key": x');
    await p.close();
  });

  test("lists: add pills with Enter, remove with ×; the flow style is kept", async () => {
    const n = await note("Tags.md", "---\ntags: [home]\n---\nBody");
    const p = await openNote(n.id);
    await p.click('.prop-row[data-key="tags"] .prop-pill-input');
    await p.keyboard.type("#garden");
    await p.keyboard.press("Enter");
    await until(async () => (await fm(n.id)).includes("tags: [home, garden]"));
    // Focus comes back to the list input, so several can be typed in a row.
    await until(async () => (await p.evaluate(() => document.activeElement?.classList.contains("prop-pill-input"))) === true);
    await p.keyboard.type("diy,");
    await until(async () => (await fm(n.id)).includes("tags: [home, garden, diy]"));
    await p.click('.prop-row[data-key="tags"] .pill-x[aria-label="Remove home"]');
    await until(async () => (await fm(n.id)).includes("tags: [garden, diy]"));
    await p.close();
  });

  test("add, rename and remove properties; Edit YAML shows the source", async () => {
    const n = await note("Manage.md", "---\nstatus: open\n---\nBody");
    const p = await openNote(n.id);
    await p.click(".prop-new-key");
    await p.keyboard.type("aliases");
    await p.select(".prop-new-type", "list");
    await p.keyboard.press("Enter");
    await p.click(".prop-new-key");
    await p.keyboard.press("Enter"); // empty name: nothing happens
    await until(async () => (await fm(n.id)).includes("aliases:"));
    await setInput(p, '.prop-row[data-key="status"] .prop-key', "state");
    await until(async () => (await fm(n.id)).includes("state: open"));
    await p.click('.prop-row[data-key="aliases"] .prop-del');
    await until(async () => !(await fm(n.id)).includes("aliases"));
    await p.click(".props-yaml");
    await until(async () => (await content(p)).includes("state: open") && !(await p.$(".cm-lp-props")));
    await p.close();
  });

  test("Add property on a note without frontmatter creates it", async () => {
    const n = await note("Bare.md", "# Bare\n\nText");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu button")].find((b) => b.textContent?.includes("Add property"))!.click());
    await until(async () => (await p.evaluate(() => document.activeElement?.classList.contains("prop-new-key"))) === true);
    await p.keyboard.type("status");
    await p.keyboard.press("Enter");
    await until(async () => (await api(`/vaults/${vaultId}/notes/${n.id}`)).content.startsWith("---\nstatus:\n---\n# Bare"));
    await p.close();
  });

  test("a property edit reaches a collaborator live", async () => {
    const n = await note("SharedProps.md", "---\nstatus: open\n---\nBody");
    const [a, b] = [await openNote(n.id), await openNote(n.id)];
    await a.bringToFront();
    await setInput(a, '.prop-row[data-key="status"] .prop-input', "shipped");
    await until(async () => (await b.$eval('.prop-row[data-key="status"] .prop-input', (e) => (e as HTMLInputElement).value)) === "shipped");
    await a.close();
    await b.close();
  });
});

describe("pictures", () => {
  beforeAll(freshBrowser);
  test("a large photo is resized to 2048px JPEG before upload and shown inline", async () => {
    const t = await note("Photos.md", "Photo below\n");
    const p = await openNote(t.id);
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    // A noisy 4000×3000 JPEG, made in the page, fed to the picture picker.
    await p.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 4000;
      c.height = 3000;
      const g = c.getContext("2d")!;
      const img = g.createImageData(4000, 3000);
      for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
      g.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.95));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "IMG_0001.jpg", { type: "image/jpeg" }));
      const input = document.querySelector<HTMLInputElement>('input[type=file][accept="image/*"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(async () => (await api(`/vaults/${vaultId}/notes/${t.id}`)).content.includes("![[attachments/IMG_0001.jpg]]"), 15000);
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("ArrowUp");
    await until(async () => (await p.$$eval(".cm-lp-image", (i) => (i as HTMLImageElement[]).map((x) => x.naturalWidth))).includes(2048), 10000);
    const file = await fetch(`${BASE}/api/vaults/${vaultId}/files?path=${encodeURIComponent("attachments/IMG_0001.jpg")}`, { headers: { cookie } });
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect((await file.arrayBuffer()).byteLength).toBeLessThan(4_000_000);
    await p.close();
  }, 30000);
});

describe("folders, drag and drop, trash", () => {
  beforeAll(freshBrowser);
  test("new folder, subfolder, and deleting an empty one with Undo", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('.sidebar-actions button[aria-label="New folder"]');
    await answer(p, "Recipes");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes"));
    await p.waitForSelector('button[aria-label="Recipes folder actions"]');
    await folderAction(p, "Recipes", "New folder inside");
    await answer(p, "Desserts");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await p.waitForFunction(() => [...document.querySelectorAll(".tree-label")].some((e) => e.textContent === "Desserts"));
    // No "Are you sure?" for an empty folder: it goes at once, and Undo brings it back.
    await folderAction(p, "Desserts", "Delete empty folder");
    await until(async () => !(await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await clickToast(p, "Undo");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await folderAction(p, "Desserts", "Delete empty folder");
    await until(async () => !(await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await p.close();
  });

  test("a dialog over Settings: Escape closes only the dialog", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".modal");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Leave vault")!.click());
    await p.waitForSelector("[data-dialog-action]");
    expect(await p.$$eval(".modal", (m) => m.length)).toBe(2);
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$eval(".modal", (m) => m.length)) === 1);
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Settings");
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 0);
    await p.close();
  });

  test("drag a note into a folder with the mouse; a click still opens notes", async () => {
    await note("Pancakes.md", "# Pancakes");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await Bun.sleep(300);
    const a = await rowCenter(p, "Pancakes");
    const t = await rowCenter(p, "Recipes");
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(a.x + ((t.x - a.x) * i) / 10, a.y + ((t.y - a.y) * i) / 10);
    expect(await p.$eval(".tree-row.drop-over .tree-label", (e) => e.textContent)).toBe("Recipes");
    await p.mouse.up();
    await until(async () => (await paths()).includes("Recipes/Pancakes.md"));
    expect(p.url()).toBe(`${BASE}/v/${vaultId}`); // the drop didn't open the note
    await p.close();
  });

  test("long-press drags on touch; a swipe scrolls instead", async () => {
    await note("Apples.md", "# Apples"); // sorts just below the folders, so both fit on a phone screen
    const p = await open(`/v/${vaultId}`, true);
    await (await p.waitForSelector('button[aria-label="Files"]'))!.click(); // the app renders after its session request
    await p.waitForSelector(".tree-row");
    await Bun.sleep(400);
    // Both rows on screen first, then measure both without scrolling again.
    await rowCenter(p, "Recipes");
    await rowCenter(p, "Apples");
    let a = await rowCenter(p, "Apples", false);
    const t = await rowCenter(p, "Recipes", false);
    await p.touchscreen.touchStart(a.x, a.y);
    await Bun.sleep(550);
    for (let i = 1; i <= 10; i++) await p.touchscreen.touchMove(a.x + ((t.x - a.x) * i) / 10, a.y + ((t.y - a.y) * i) / 10);
    await p.touchscreen.touchEnd();
    await until(async () => (await paths()).includes("Recipes/Apples.md"));
    a = await rowCenter(p, "Recipes");
    await p.touchscreen.touchStart(a.x, a.y);
    await p.touchscreen.touchMove(a.x, a.y + 80);
    await p.touchscreen.touchEnd();
    expect(await p.$(".drag-ghost")).toBeNull();
    await p.close();
  });

  test("Move to… files a note into a folder from its menu, and Undo puts it back", async () => {
    const n = await note("Filed.md", "file me");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Move to…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("recip");
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Recipes/Filed.md"));
    await until(async () => (await p.$eval(".breadcrumb", (e) => e.textContent).catch(() => "")) === "Recipes");
    await clickToast(p, "Undo");
    await until(async () => (await paths()).includes("Filed.md"));
    await p.close();
  });

  test("Move to Trash, then restore from the Trash screen", async () => {
    const n = await note("Doomed.md", "keep me");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))!.click());
    await until(async () => !(await paths()).includes("Doomed.md"));
    await p.click('button[aria-label="Trash"]');
    await p.waitForSelector(".trash-list li");
    expect(await p.$eval(".trash-list li", (e) => e.textContent)).toContain("Doomed");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".trash-list button")].find((b) => b.textContent?.includes("Restore"))!.click());
    await until(async () => (await paths()).includes("Doomed.md"));
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Doomed");
    await p.close();
  });

  test("Move to Trash offers Undo, which brings the note back and opens it", async () => {
    const n = await note("Oops.md", "not yet");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))!.click());
    await until(async () => !(await paths()).includes("Oops.md"));
    expect(await p.$eval(".toast", (e) => e.textContent)).toContain("Moved “Oops” to Trash");
    await clickToast(p, "Undo");
    await until(async () => (await paths()).includes("Oops.md"));
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Oops");
    await p.close();
  });

  test("on a phone the note menu is an action sheet", async () => {
    const n = await note("Sheet.md", "x");
    const p = await openNote(n.id, true);
    await p.click('button[aria-label="More"]');
    await p.waitForSelector(".menu.sheet");
    const { height } = (await (await p.$(".menu.sheet .menu-item"))!.boundingBox())!;
    expect(height).toBeGreaterThanOrEqual(44); // a finger-sized target
    await p.click(".menu-cancel");
    await p.waitForSelector(".menu.sheet", { hidden: true });
    await p.close();
  });
});

describe("commands: the / menu and ⌘K", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const endOfDoc = async (p: Page) => {
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
  };

  test("/ at the start of a line offers blocks; /tab inserts a table and /todo makes a to-do", async () => {
    const n = await note("Slash.md", "# Slash\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("/");
    await p.waitForSelector(".cm-tooltip-autocomplete");
    expect(await p.$$eval(".cm-tooltip-autocomplete li", (l) => l.length)).toBeGreaterThan(10);
    await p.keyboard.type("tab");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("Table"));
    await Bun.sleep(150); // CodeMirror ignores Enter for 75 ms after the list changes
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes("| Column | Column |\n| --- | --- |"));
    expect(await raw(n.id)).not.toContain("/tab");
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("/todo");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("To-do"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.keyboard.type("Buy grout");
    await until(async () => (await raw(n.id)).includes("\n- [ ] Buy grout"));
    await p.close();
  });

  test("a slash inside a word, a URL or code doesn't open the menu", async () => {
    const n = await note("NoSlash.md", "x\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.keyboard.type(" and/or https://example.com/a `a/b` ");
    await Bun.sleep(300);
    expect(await p.$(".cm-tooltip-autocomplete")).toBeNull();
    await p.close();
  });

  test("⌘K lists every command, including this note's, and runs one", async () => {
    const n = await note("Palette.md", "# Palette\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette li");
    const titles = await p.$$eval(".palette li .palette-title", (l) => l.map((e) => e.textContent));
    for (const t of ["Move to Trash", "Heading 1", "Graph view", "New folder", "Vault settings"]) expect(titles).toContain(t);
    await p.keyboard.type("graph");
    await p.keyboard.press("Enter");
    await until(() => p.url().endsWith(`/v/${vaultId}/graph`));
    await p.close();
  });
});

describe("block handle (F12)", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  /** Hover a line so its handle shows; the handle's grip and + as screen points. */
  const hoverLine = async (p: Page, text: string) => {
    const r = (await rowOfLine(p, text))!;
    await p.mouse.move(r.x + 30, r.y + r.height / 2);
    await p.waitForSelector(".cm-block-handle:not([hidden])");
    await Bun.sleep(50);
    const box = async (sel: string) => {
      const b = (await (await p.$(sel))!.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    return { grip: await box(".cm-block-grip"), plus: await box(".cm-block-plus"), line: r };
  };

  test("dragging a list item moves it with its sub-items, while someone else types; Undo puts it back", async () => {
    const start = "# Plan\n\n- Alpha\n  - one\n  - two\n- Beta\n- Gamma\n\nEnd";
    const n = await note("Drag.md", start);
    const [a, b] = [await openNote(n.id), await openNote(n.id)];
    // Someone else is typing at the end of the note.
    await b.bringToFront();
    await b.click(".cm-content");
    await b.keyboard.down("Meta");
    await b.keyboard.press("ArrowDown");
    await b.keyboard.up("Meta");
    await b.keyboard.type(" and more");
    await a.bringToFront();
    await until(async () => (await content(a)).includes("End and more"));
    const { grip } = await hoverLine(a, "Alpha");
    const to = (await rowOfLine(a, "Gamma"))!;
    await a.mouse.move(grip.x, grip.y);
    await a.mouse.down();
    for (let i = 1; i <= 8; i++) await a.mouse.move(grip.x, grip.y + ((to.y + to.height * 0.8 - grip.y) * i) / 8);
    await a.waitForSelector(".cm-block-drop:not([hidden])");
    await a.mouse.up();
    await until(async () => (await raw(n.id)).includes("- Beta\n- Gamma\n- Alpha\n  - one\n  - two\n\nEnd"));
    // The other person's typing survived, and they see the move.
    expect(await raw(n.id)).toContain("End and more");
    await until(async () => (await content(b)).indexOf("Gamma") < (await content(b)).indexOf("Alpha"));
    await a.click(".cm-content");
    await a.keyboard.down("Meta");
    await a.keyboard.press("z");
    await a.keyboard.up("Meta");
    await until(async () => (await raw(n.id)).startsWith(start));
    await a.close();
    await b.close();
  });

  test("+ adds a line below with the / menu open; ⋮⋮ turns a block into a to-do and deletes one with Undo", async () => {
    const n = await note("Handle.md", "First idea\n\nSecond idea");
    const p = await openNote(n.id);
    const { plus } = await hoverLine(p, "First idea");
    await p.mouse.click(plus.x, plus.y);
    await p.waitForSelector(".cm-tooltip-autocomplete");
    await p.keyboard.type("h2");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("Heading 2"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.keyboard.type("Between");
    await until(async () => (await raw(n.id)) === "First idea\n\n## Between\n\nSecond idea");

    let h = await hoverLine(p, "Second idea");
    await p.mouse.click(h.grip.x, h.grip.y);
    await p.waitForSelector(".menu.popover");
    await p.click(".menu.popover .menu-item:nth-child(1)"); // Turn into…
    await p.waitForSelector(".choose input");
    await p.keyboard.type("to-do");
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).endsWith("\n- [ ] Second idea"));

    h = await hoverLine(p, "First idea");
    await p.mouse.click(h.grip.x, h.grip.y);
    await p.waitForSelector(".menu.popover");
    const del = await p.evaluateHandle(() => [...document.querySelectorAll(".menu.popover .menu-item")].find((b) => b.textContent === "Delete"));
    await (del as any).click();
    await until(async () => (await raw(n.id)) === "## Between\n\n- [ ] Second idea");
    await clickToast(p, "Undo");
    await until(async () => (await raw(n.id)) === "First idea\n\n## Between\n\n- [ ] Second idea");
    await p.close();
  });

  test("on a phone the ⋮⋮ sits by the cursor's block; a long press drags it", async () => {
    const n = await note("PhoneDrag.md", "Top line\n\nMiddle line\n\nBottom line");
    const p = await openNote(n.id, true);
    const r = (await rowOfLine(p, "Top line"))!;
    await p.touchscreen.tap(r.x + 40, r.y + r.height / 2);
    await p.waitForSelector(".cm-block-handle.touch:not([hidden])");
    const g = (await (await p.$(".cm-block-grip"))!.boundingBox())!;
    expect(Math.abs(g.y + g.height / 2 - (r.y + r.height / 2))).toBeLessThan(6); // beside that line
    const to = (await rowOfLine(p, "Bottom line"))!;
    const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
    await p.touchscreen.touchStart(from.x, from.y);
    await Bun.sleep(550);
    for (let i = 1; i <= 8; i++) await p.touchscreen.touchMove(from.x, from.y + ((to.y + to.height * 0.8 - from.y) * i) / 8);
    await p.touchscreen.touchEnd();
    await until(async () => (await raw(n.id)) === "Middle line\n\nBottom line\n\nTop line");
    await p.close();
  });
});

describe("GitHub vaults (F14)", () => {
  beforeAll(freshBrowser);
  const gh = startFakeGitHub(3286);
  afterAll(() => gh.stop());
  let gv = 0;
  const barText = (p: Page) => p.$eval(".branch-bar", (e) => e.textContent ?? "");

  test("New vault from GitHub, not connected yet: Connect opens Settings → Connections over the dialog, and connecting there carries on", async () => {
    await api("/me/github", undefined, "DELETE");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector('select[aria-label="Vault"]');
    await p.select('select[aria-label="Vault"]', "github");
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Connect GitHub…"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Connect GitHub…")!.click());
    await p.waitForSelector('input[aria-label="GitHub token"]');
    expect(await p.$eval(".settings-nav [aria-current=page]", (e) => e.textContent)).toStartWith("Connections");
    await p.type('input[aria-label="GitHub token"]', TOKEN);
    await p.click(".github-connect button.primary");
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Disconnect"));
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 1);
    await p.waitForSelector('select[aria-label="Repository"] option[value="sam/house"]');
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("New vault from GitHub");
    await p.close();
  });

  test("New vault from GitHub: pick the repo and folder; the bar shows the branch and what changed, on the laptop and the iPhone", async () => {
    await api("/me/github", { token: TOKEN }, "PUT");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector('select[aria-label="Vault"]');
    await p.select('select[aria-label="Vault"]', "github");
    await p.waitForSelector('select[aria-label="Folder"] option[value="docs"]');
    await p.select('select[aria-label="Folder"]', "docs");
    await p.waitForFunction(() => document.querySelector(".modal button.primary")?.textContent === "Copy 3 notes in");
    await p.click(".modal button.primary");
    await p.waitForSelector(".branch-bar .branch-count");
    gv = Number(/\/v\/(\d+)/.exec(p.url())![1]);
    expect(await barText(p)).toContain("Same as main");
    const boiler = ((await api(`/vaults/${gv}/notes`)) as any[]).find((n) => n.path === "Boiler.md");
    await p.goto(`${BASE}/v/${gv}/n/${boiler.id}`);
    await p.waitForSelector(".cm-content");
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type("Checked the flue.");
    await p.waitForFunction(() => document.querySelector(".branch-bar")?.textContent?.includes("1 note changed"), { timeout: 8000 });
    expect(await barText(p)).toContain("On commonplace/boiler");
    // The iPhone shows the same bar.
    const phone = await open(`/v/${gv}/n/${boiler.id}`, true);
    await phone.waitForFunction(() => document.querySelector(".branch-bar")?.textContent?.includes("1 note changed"));
    const bar = (await (await phone.$(".branch-bar"))!.boundingBox())!;
    expect(bar.width).toBeLessThanOrEqual(390);
    await phone.close();
    await p.close();
  });

  test("Review changes shows the diff; Open pull request sends one commit to a new branch with a PR", async () => {
    const p = await open(`/v/${gv}`);
    await p.waitForSelector(".branch-count");
    await p.click(".branch-count");
    await p.waitForSelector(".change-edited");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".change-edited button")].find((b) => b.textContent === "Diff")!.click());
    await p.waitForSelector(".change .diff .diff-add");
    expect(await p.$eval(".change .diff .diff-add", (e) => e.textContent)).toContain("Checked the flue.");
    await p.click('.branch-bar button[aria-label="Open pull request"]');
    await p.waitForSelector(".pr-form");
    expect(await p.$eval('.pr-form input[required]', (e) => (e as HTMLInputElement).value)).toBe("commonplace/boiler");
    await p.click(".pr-form button.primary");
    await p.waitForSelector(".branch-pr");
    expect(await p.$eval(".branch-pr", (e) => e.textContent)).toContain("#1");
    expect(gh.files("commonplace/boiler")["docs/Boiler.md"]).toContain("Checked the flue.");
    expect(gh.files("main")["docs/Boiler.md"]).not.toContain("Checked the flue.");
    await p.close();
  });

  test("Cancel the branch asks first, then puts every note back", async () => {
    const p = await open(`/v/${gv}`);
    await p.waitForSelector('.branch-bar button[aria-label="Branch"]');
    await p.click('.branch-bar button[aria-label="Branch"]');
    await p.waitForSelector(".menu");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")].find((b) => b.textContent === "Cancel the branch")!.click());
    await p.waitForSelector("[data-dialog-action]");
    expect(await p.$eval(".dialog-message", (e) => e.textContent)).toContain("Pull request #1 stays open");
    await p.click("[data-dialog-action]");
    await p.waitForFunction(() => document.querySelector(".branch-bar")?.textContent?.includes("Same as main"));
    const boiler = ((await api(`/vaults/${gv}/notes`)) as any[]).find((n) => n.path === "Boiler.md");
    expect((await api(`/vaults/${gv}/notes/${boiler.id}`)).content).not.toContain("flue.");
    await p.close();
  });
});

describe("templates and daily notes", () => {
  beforeAll(freshBrowser);
  const read = async (path: string) => {
    const n = ((await api(`/vaults/${vaultId}/notes`)) as { id: number; path: string }[]).find((x) => x.path === path);
    return n ? ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string) : null;
  };

  test("Today uses Templates/Daily.md; the arrows and the calendar move between days", async () => {
    await note("Templates/Daily.md", "# {{date:dddd D MMMM}}\n\n## Plan\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('.sidebar-actions button[title^="Today"]');
    const today = new Date();
    await until(async () => (await read(dailyPath(today))) === `# ${formatDate(today, "dddd D MMMM")}\n\n## Plan\n`);
    await p.waitForSelector(".day-nav");
    await p.click('.day-nav button[title="Previous day"]');
    const yesterday = addDays(today, -1);
    await until(async () => (await read(dailyPath(yesterday))) !== null);
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === formatDate(yesterday, "YYYY-MM-DD"));
    // The calendar marks both days and opens today's again.
    await p.waitForSelector(".calendar-day.has");
    expect(await p.$$eval(".calendar-day.has", (d) => d.length)).toBeGreaterThanOrEqual(1);
    await p.click(".calendar-day.today");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === formatDate(today, "YYYY-MM-DD"));
    await p.close();
  });

  test("Insert template merges its properties and fills {{title}}", async () => {
    await note("Templates/Meeting.md", "---\ntags: [meeting]\nstatus: open\n---\n## Attendees\n- {{title}}\n");
    const n = await note("Standup.md", "---\nstatus: done\n---\n# Standup\n");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Insert template…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("meet");
    await p.keyboard.press("Enter");
    await until(async () => ((await read("Standup.md")) ?? "").includes("- Standup"));
    const text = (await read("Standup.md"))!;
    expect(text.match(/^---/gm)!.length).toBe(2); // still one frontmatter block
    expect(text).toContain("status: done"); // the note's own value wins
    expect(text).toMatch(/tags:[\s\S]*meeting/);
    await p.close();
  });

  test("New note from a template asks for a title", async () => {
    const p = await open(`/v/${vaultId}`);
    // The button appears once the note list (with its templates) has loaded.
    await p.waitForFunction(() => [...document.querySelectorAll(".quick-actions button")].some((b) => b.textContent?.includes("From a template")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".quick-actions button")].find((b) => b.textContent?.includes("From a template"))!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("meet");
    await p.keyboard.press("Enter");
    await answer(p, "Board review");
    await until(async () => ((await read("Board review.md")) ?? "").includes("- Board review"));
    await p.close();
  });
});

describe("Settings (F17)", () => {
  beforeAll(freshBrowser);
  const current = (p: Page) => p.$eval(".settings-nav [aria-current=page]", (e) => e.textContent ?? "");
  const modalText = (p: Page) => p.$eval(".modal", (e) => e.textContent ?? "");
  const closeAll = async (p: Page) => {
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 0);
  };

  test("one Settings screen: the gear opens This vault, the account button Account, and ⌘K finds a section by what it's about", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".settings-nav [aria-current=page]");
    expect(await current(p)).toStartWith("This vault");
    expect(await modalText(p)).toContain("Members");
    await closeAll(p);
    await p.click("button.account");
    await p.waitForSelector(".settings-nav [aria-current=page]");
    expect(await current(p)).toStartWith("Account");
    expect(await modalText(p)).toContain("Change password");
    await closeAll(p);
    for (const [words, section, shows] of [["github token", "Connections", "GitHub"], ["members", "Vault settings", "Members"], ["api key", "AI assistants", "AI assistants"]] as const) {
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      await p.waitForSelector(".palette input");
      await p.keyboard.type(words);
      await p.waitForFunction((t) => [...document.querySelectorAll(".palette .palette-title")].some((e) => e.textContent === t), {}, section);
      await p.evaluate((t) => [...document.querySelectorAll<HTMLElement>(".palette .palette-title")].find((e) => e.textContent === t)!.click(), section);
      await p.waitForSelector(".settings-nav [aria-current=page]");
      expect(await modalText(p)).toContain(shows);
      await closeAll(p);
    }
    await p.close();
  });

  test("on the iPhone the list of sections comes first; a section opens in its place, with a way back", async () => {
    const p = await open(`/v/${vaultId}`, true);
    await (await p.waitForSelector('button[aria-label="Files"]', { visible: true }))!.click();
    await Bun.sleep(400); // the drawer slides in
    await p.click("button.account");
    await p.waitForSelector(".settings-pane");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Account");
    expect(await p.$(".settings-nav")).not.toBeNull();
    expect(await p.$eval(".settings-nav", (e) => getComputedStyle(e).display)).toBe("none");
    await p.click(".settings-back");
    await p.waitForFunction(() => !document.querySelector(".settings-pane"));
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Settings");
    const rows = await p.$$eval(".settings-nav button", (b) => b.map((x) => x.querySelector(".settings-nav-text")!.firstChild!.textContent));
    expect(rows).toEqual(["Account", "This vault", "Website", "AI assistants", "Connections", "Admin"]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForSelector(".settings-pane");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Connections");
    expect((await (await p.$(".modal"))!.boundingBox())!.width).toBeLessThanOrEqual(390);
    await p.close();
  });
});

describe("share from iPhone", () => {
  beforeAll(freshBrowser);
  test("Settings → Connections makes a capture token that saves to the inbox, and revoking it stops it", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click("button.account");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Create token")); // after the vault list loads
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create token")!.click());
    await p.waitForSelector(".capture-setup code");
    const line = await p.$$eval(".capture-setup code", (c) => c.map((e) => e.textContent ?? "").find((t) => t.startsWith("Bearer "))!);
    const share = (auth: string) => fetch(`${BASE}/api/capture`, { method: "POST", headers: { authorization: auth }, body: "Buy grout" });
    expect((await share(line)).status).toBe(200);
    await until(async () => (await paths()).includes("Inbox.md"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".capture-setup button")].find((b) => b.textContent === "Done")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".members li")].some((li) => li.textContent?.includes("last used")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".members .danger-link")].find((b) => b.textContent === "Revoke")!.click());
    await p.click("[data-dialog-action]");
    await until(async () => (await share(line)).status === 401);
    await p.close();
  });
});

describe("connect Claude (MCP)", () => {
  beforeAll(freshBrowser);
  test("Settings → Connections makes an MCP token and shows the Claude Code command; the token works, then revokes", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click("button.account");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Create MCP token"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create MCP token")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".capture-setup code")].some((c) => c.textContent?.startsWith("claude mcp add")));
    const cmd = await p.$$eval(".capture-setup code", (c) => c.map((e) => e.textContent ?? "").find((t) => t.startsWith("claude mcp add"))!);
    const token = /Bearer (cpm_[\w-]+)/.exec(cmd)![1]!;
    expect(cmd).toContain(`${BASE}/mcp`);
    const list = () =>
      fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await (await list()).json()).result.tools.length).toBe(16);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".capture-setup button")].find((b) => b.textContent === "Done")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".members li")].some((li) => li.textContent?.includes("read and write")));
    await p.evaluate(() =>
      [...document.querySelectorAll(".members li")]
        .find((li) => li.textContent?.includes("read and write"))!
        .querySelector<HTMLButtonElement>(".danger-link")!
        .click(),
    );
    await p.click("[data-dialog-action]");
    await until(async () => (await list()).status === 401);
    await p.close();
  });
});

describe("bring your own AI", () => {
  beforeAll(freshBrowser);
  const fake = startFakeAi(3296);
  afterAll(() => fake.stop());
  const noteText = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const typeAtEnd = async (p: Page, text: string) => {
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(text);
  };
  const ask = async (p: Page, scope: string, text: string) => {
    const box = await p.waitForSelector(`${scope} .ai-input textarea`);
    await box!.click();
    await p.keyboard.type(text);
    await p.keyboard.press("Enter");
  };
  const replies = (p: Page, scope: string) => p.$$eval(`${scope} .ai-reply`, (r) => r.map((e) => e.textContent ?? "").join(" | "));

  test("/boyai adds an assistant with its own key; Test checks it works", async () => {
    const n = await note("Plan.md", "# Plan\n\n");
    const p = await openNote(n.id);
    await typeAtEnd(p, "/boyai");
    await p.waitForSelector(".cm-tooltip-autocomplete");
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".assistant-form");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Bring your own AI");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form [role=radio]")].find((b) => b.textContent === "Other")!.click());
    const fill = async (label: string, value: string) => {
      const input = await p.evaluateHandle((l) => [...document.querySelectorAll(".assistant-form label")].find((x) => x.querySelector(".field-label")?.textContent === l)!.querySelector("input"), label);
      await (input as any).click();
      await (input as any).evaluate((e: HTMLInputElement) => e.select());
      await p.keyboard.type(value);
    };
    expect(await p.$eval(".assistant-form input", (e) => (e as HTMLInputElement).value)).toBe("Assistant"); // the name follows the provider until you type one
    await fill("Name", "Claude");
    await fill("Base URL", `${fake.url}/v1`);
    await fill("Model", "test-model");
    await fill("API key", "fake-ui-key");
    // An unknown model needs its price for the £1 daily limit.
    expect(await p.$eval(".assistant-form", (e) => e.textContent)).toContain("Enter the model's price");
    const price = async (label: string, v: string) => {
      await p.click(`input[aria-label="${label}"]`);
      await p.keyboard.type(v);
    };
    await price("Price per million input tokens, in pounds", "0.5");
    await price("Price per million output tokens, in pounds", "2");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form button")].find((b) => b.textContent === "Test")!.click());
    await p.waitForSelector(".assistant-form .ok");
    expect(await p.$eval(".assistant-form .ok", (e) => e.textContent)).toContain("It works");
    await p.click(".assistant-form button[type=submit]");
    await p.waitForSelector(".assistant-form", { hidden: true });
    const mine = await api("/me/assistants");
    expect(mine).toMatchObject([{ name: "Claude", provider: "compatible", model: "test-model", key_hint: "-key", price: { in: 0.5, out: 2 }, daily_cap: 1 }]);
    expect(JSON.stringify(mine)).not.toContain("fake-ui-key");
    expect(fake.seen.at(-1)!.headers.authorization).toBe("Bearer fake-ui-key");
    await p.close();
  });

  test("@Claude opens a chat under the line; it writes into the note live; ✓ keeps it as a callout", async () => {
    await note("Boiler.md", "# Boiler\n\nService due in March.\n");
    const n = await note("Plan 2.md", "# Plan 2\n\n");
    const p = await openNote(n.id);
    await typeAtEnd(p, "@Cl");
    await p.waitForFunction(() => [...document.querySelectorAll(".cm-completionLabel")].some((e) => e.textContent === "@Claude"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".cm-ai-inline .ai-chat");
    expect(await content(p)).not.toContain("@Cl"); // the mention itself is not left in the note
    fake.script.push({ text: "Looking.", calls: [{ name: "search_notes", input: { query: "boiler" } }] }, { calls: [{ name: "append_to_note", input: { note: "Plan 2", text: "- Boiler service in March ([[Boiler]])" } }] }, { text: "Added it." });
    // The box has focus: typing goes to it, not the note.
    await until(() => p.evaluate(() => document.activeElement?.closest(".cm-ai-inline") !== null));
    await p.keyboard.type("Add the boiler here");
    await p.keyboard.press("Enter");
    await until(async () => (await content(p)).includes("Boiler service in March"), 8000);
    await until(async () => (await replies(p, ".cm-ai-inline")).includes("Added it."));
    expect(await p.$$eval(".cm-ai-inline .ai-tool", (t) => t.map((e) => e.textContent?.trim()))).toEqual(["Searched for “boiler”: 1 found", "Changed Plan 2.md"]);
    expect(await p.$eval(".cm-ai-inline .ai-cost", (e) => e.textContent)).toBe("≈ under 1p");
    expect(await p.$eval(".cm-ai-inline .ai-cost", (e) => e.getAttribute("title"))).toContain("of its £1.00 limit");
    await p.click('.cm-ai-inline button[aria-label="Keep in the note"]');
    await p.waitForSelector(".cm-ai-inline", { hidden: true });
    await until(async () => (await noteText(n.id)).includes("> [!ai]- Claude,"), 8000);
    const text = await noteText(n.id);
    expect(text).toContain("> **Ui:** Add the boiler here");
    expect(text).toContain("> **Claude:** Looking.");
    await p.close();
  });

  test("⌘J opens the AI panel; a new page waits for Apply, with a diff, and Undo takes it back; Discard leaves the note", async () => {
    const n = await note("Plan 3.md", "# Plan 3\n\n- one\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("j");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".right-panel .ai-panel textarea");
    fake.script.push({ text: "Here's a page.", calls: [{ name: "create_note", input: { path: "Boiler summary", content: "# Boiler summary\n\nService in March.\n" } }] }, { text: "Done." });
    await ask(p, ".ai-panel", "Make a boiler page");
    await p.waitForSelector(".ai-change");
    expect(await p.$eval(".ai-change-head", (e) => e.textContent)).toContain("Create “Boiler summary”");
    expect(await p.$$eval(".ai-change .diff-add", (l) => l.length)).toBe(3);
    expect(await paths()).not.toContain("Boiler summary.md");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Apply")!.click());
    await until(async () => (await paths()).includes("Boiler summary.md"));
    await until(async () => (await replies(p, ".ai-panel")).includes("Done."));
    await clickToast(p, "Undo");
    await until(async () => !(await paths()).includes("Boiler summary.md"));

    fake.script.push({ calls: [{ name: "rewrite_note", input: { note: "Plan 3", content: "# Plan 3\n\n| one |\n" } }] }, { text: "Left it as it was." });
    await ask(p, ".ai-panel", "Make it a table");
    await p.waitForSelector(".ai-change .diff-del");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Discard")!.click());
    await until(async () => (await replies(p, ".ai-panel")).includes("Left it as it was."));
    expect(await noteText(n.id)).toBe("# Plan 3\n\n- one\n");
    await p.close();
  });

  test("it can drive the app: hiding the file panel through the command list", async () => {
    const n = await note("Plan 4.md", "# Plan 4\n");
    const p = await openNote(n.id);
    // The panel remembers it was left open on the AI tab.
    await p.waitForSelector(".ai-panel textarea");
    const tools = () => fake.seen.at(-1)!.body.tools.map((t: any) => t.function.name);
    fake.script.push({ calls: [{ name: "run_app_command", input: { command: "view.files" } }] }, { text: "Hidden." });
    await ask(p, ".ai-panel", "Hide the file panel");
    await until(() => p.$eval(".sidebar", (e) => getComputedStyle(e).visibility === "hidden"));
    await until(async () => (await replies(p, ".ai-panel")).includes("Hidden."));
    expect(tools()).toContain("run_app_command");
    expect(fake.seen.at(-1)!.body.messages.at(-1)).toMatchObject({ role: "tool", content: "Ran “Show or hide the file panel”" });
    await p.evaluate(() => (localStorage.setItem("cp:left", "1"), localStorage.setItem("cp:right", "1"), localStorage.setItem("cp:rightTab", "links")));
    await p.close();
  });

  test("on the iPhone, @Claude opens a bottom sheet over the formatting bar", async () => {
    const n = await note("Phone plan.md", "# Phone plan\n\n");
    const p = await openNote(n.id, true);
    await p.tap(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type("@Cl");
    await p.waitForFunction(() => [...document.querySelectorAll(".cm-completionLabel")].some((e) => e.textContent === "@Claude"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".ai-sheet .ai-chat");
    expect(await p.$(".cm-ai-inline")).toBeNull();
    const sheet = (await (await p.$(".ai-sheet"))!.boundingBox())!;
    expect(sheet.y + sheet.height).toBeGreaterThan(800); // at the bottom of the 844 pt screen
    await p.click('.ai-sheet button[aria-label="Discard"]');
    await p.waitForSelector(".ai-sheet", { hidden: true });
    await p.close();
  });
});

describe("types (F16)", () => {
  beforeAll(freshBrowser);
  let sam = 0;
  const choose = async (p: Page, label: string) => {
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type(label);
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await p.waitForSelector("[data-dialog-input]", { hidden: true });
  };
  const read = async (path: string) => {
    const n = ((await api(`/vaults/${vaultId}/notes`)) as any[]).find((x) => x.path === path);
    return n ? ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string) : null;
  };

  test("a type page: sidebar → table → edit a cell → save a view as .base", async () => {
    await note("Types/Person.md", "---\nicon: user\ncolour: blue\nproperties:\n  - name: role\n    kind: select\n    options: [Builder, Friend]\n  - name: phone\n    kind: text\n---\n# {{title}}\n\n## Notes\n");
    await note("Types/Meeting.md", "---\nicon: calendar\nproperties:\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n# {{title}}\n\n## Agenda\n");
    sam = (await note("People/Sam.md", "---\ntype: Person\nrole: Builder\n---\n# Sam\n")).id;
    await note("People/Alex.md", "---\ntype: Person\n---\n# Alex\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForFunction(() => [...document.querySelectorAll(".types-list .type-row")].some((b) => b.textContent?.includes("Person")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".type-row")].find((b) => b.textContent?.includes("Person"))!.click());
    await p.waitForSelector(".type-table tbody tr");
    expect(await p.$$eval(".type-table tbody .type-row-title", (r) => r.map((e) => e.textContent))).toEqual(["Alex", "Sam"]);
    // Alex's role, from the select in the table.
    await p.select(".type-table tbody tr:first-child select", "Friend");
    await until(async () => (await read("People/Alex.md"))?.includes("role: Friend") ?? false);
    // Group by role, save the view, and it's a Bases (`.base`) file.
    await p.select('select[aria-label="Group by"]', "role");
    await p.waitForSelector(".type-group h3");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Save view"))!.click());
    await answer(p, "By role");
    await p.waitForFunction(() => [...document.querySelectorAll(".type-views [role=tab]")].some((t) => t.textContent === "By role"));
    const views = (await api(`/vaults/${vaultId}/types/Person`)).views as string;
    expect(views).toContain('type == "Person"');
    expect(views).toContain("groupBy:\n      property: note.role");
    await p.close();
  });

  test("New Person uses the type's template; the chip changes a note's type", async () => {
    const p = await open(`/v/${vaultId}/t/Person`);
    await p.waitForSelector(".type-table, .type-list");
    await p.waitForFunction(() => [...document.querySelectorAll("button.primary")].some((b) => b.textContent?.includes("New"))); // once the vault's types load
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button.primary")].find((b) => b.textContent?.includes("New"))!.click());
    await answer(p, "Jo");
    await p.waitForSelector(".cm-content");
    await until(async () => (await read("Jo.md")) === "---\ntype: Person\n---\n# Jo\n\n## Notes\n");
    await p.waitForSelector(".type-chip");
    expect(await p.$eval(".type-chip", (e) => e.textContent?.trim())).toBe("Person");
    await p.click(".type-chip");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Make it a Meeting")!.click());
    await until(async () => (await read("Jo.md"))?.startsWith("---\ntype: Meeting\n") ?? false);
    await p.close();
  });

  test("a relation picks from the right type; the other side says 'As attendees'", async () => {
    const m = await note("Meetings/Kickoff.md", "---\ntype: Meeting\n---\n# Kickoff\n");
    const p = await openNote(m.id);
    await p.waitForSelector('.prop-row[data-key="attendees"].prop-ghost .prop-relation-add');
    await p.click('.prop-row[data-key="attendees"] .prop-relation-add');
    await p.waitForSelector("[data-dialog-input]");
    const offered = await p.$$eval(".choose-option, .modal li", (o) => o.map((e) => e.textContent ?? ""));
    expect(offered.some((t) => t.includes("Sam"))).toBe(true);
    expect(offered.some((t) => t.includes("Kickoff"))).toBe(false); // not a Person
    await choose(p, "Sam");
    await until(async () => (await read("Meetings/Kickoff.md"))?.includes('attendees:\n  - "[[Sam]]"') ?? false, 8000);
    await p.close();
    const s = await openNote(sam);
    await s.waitForFunction(() => [...document.querySelectorAll(".right-panel h3")].some((h) => h.textContent?.startsWith("As attendees")));
    await s.close();
  });

  test("New type offers starters: one click adds Book, and existing types show as added", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".types-section");
    await p.click('button[aria-label="New type"]');
    await p.waitForSelector(".starters");
    // Person exists already (from the test above), so it shows as added.
    await p.waitForFunction(() => document.querySelector(".starter.colour-blue button")?.textContent?.includes("Added"));
    await p.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".starter button")].some((b) => b.textContent === "Add Book" && !b.disabled));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".starter button")].find((b) => b.textContent === "Add Book")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".starter")].some((s) => s.textContent?.includes("Book") && s.querySelector("button")?.textContent?.includes("Added")));
    const types = (await api(`/vaults/${vaultId}/types`)).types.map((t: any) => t.name);
    expect(types).toContain("Book");
    await p.keyboard.press("Escape");
    await p.close();
  });

  test("the type editor: add a choice property without writing YAML", async () => {
    const book = (await api(`/vaults/${vaultId}/types`)).types.find((t: any) => t.name === "Book");
    const p = await openNote(book.noteId);
    await p.waitForSelector(".type-editor .type-prop");
    expect(await p.$(".cm-type-def-line")).not.toBeNull(); // no second, raw properties form
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".type-editor button")].find((b) => b.textContent?.includes("Add a property"))!.click());
    await p.waitForFunction(() => document.querySelectorAll(".type-prop").length === 5);
    const last = ".type-prop:last-child";
    await p.click(`${last} .type-prop-name`);
    await p.evaluate((sel) => document.querySelector<HTMLInputElement>(`${sel} .type-prop-name`)!.select(), last);
    await p.keyboard.type("format");
    await p.select(`${last} select`, "select");
    await p.waitForSelector(`${last} .type-choices input`);
    await p.click(`${last} .type-choices input`);
    await p.keyboard.type("Paperback,Kindle");
    await p.keyboard.press("Enter");
    await until(async () => {
      const t = (await api(`/vaults/${vaultId}/types`)).types.find((x: any) => x.name === "Book");
      return JSON.stringify(t.properties.at(-1)) === JSON.stringify({ name: "format", kind: "select", options: ["Paperback", "Kindle"] });
    }, 8000);
    await p.close();
  });

  test("a daily note lists what was made that day", async () => {
    const today = dailyPath(new Date());
    const d = (await api(`/vaults/${vaultId}/notes`)).find((n: any) => n.path === today) ?? (await note(today, "# Today\n"));
    const p = await openNote(d.id);
    await p.waitForFunction(() => [...document.querySelectorAll(".right-panel h3")].some((h) => h.textContent === "This day"));
    expect(await p.$eval(".right-panel", (e) => e.textContent ?? "")).toContain("Kickoff");
    await p.close();
  });
});

describe("embeds and link cards (F2)", () => {
  beforeAll(freshBrowser);
  test("![[Note]] and ![[Note#Heading]] show the note in place, in Live Preview and reading view; loops stop", async () => {
    await note("Embed source.md", "# Embed source\n\nIntro line.\n\n## Part two\n\nOnly this part.\n\n## Part three\n\nNot this.\n");
    await note("Loop A.md", "# Loop A\n\n![[Loop B]]\n");
    await note("Loop B.md", "# Loop B\n\n![[Loop A]]\n");
    const host = await note("Embed host.md", "# Host\n\n![[Embed source]]\n\n![[Embed source#Part two]]\n\n![[Loop A]]\n\nEnd.\n");
    const p = await openNote(host.id);
    await p.waitForFunction(() => document.querySelectorAll(".cm-lp-embed > .note-embed-body").length === 3);
    const bodies = await p.$$eval(".cm-lp-embed", (b) => b.map((e) => e.textContent ?? ""));
    expect(bodies[0]).toContain("Intro line.");
    expect(bodies[1]).toContain("Only this part.");
    expect(bodies[1]).not.toContain("Not this.");
    // Loop A shows Loop B, which would show Loop A again: it stops there.
    await p.waitForFunction(() => (document.querySelectorAll(".cm-lp-embed")[2]?.textContent ?? "").includes("Already shown above"));
    // The source stays plain markdown.
    expect(((await api(`/vaults/${vaultId}/notes/${host.id}`)).content as string)).toContain("![[Embed source#Part two]]");
    // Reading view too, and the embed's title opens it.
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForFunction(() => document.querySelectorAll(".preview .note-embed-body").length >= 3);
    await p.click(".preview .note-embed-title");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Embed source");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("a link to a typed note on its own line is a card; inline links and untyped notes stay links; a type can turn cards off", async () => {
    await note("Types/Supplier.md", "---\nicon: building\ncolour: green\nproperties:\n  - name: trade\n    kind: text\n  - name: phone\n    kind: text\n---\n");
    await note("Acme Tiles.md", "---\ntype: Supplier\ntrade: Tiles\nphone: 01234 567890\n---\n# Acme Tiles\n");
    await note("Plain note.md", "# Plain\n");
    const host = await note("Card host.md", "# Cards\n\n[[Acme Tiles]]\n\nWe use [[Acme Tiles]] for tiles.\n\n[[Plain note]]\n");
    const p = await openNote(host.id);
    await p.waitForSelector(".cm-lp-card .link-card-box");
    expect(await p.$$eval(".link-card-box", (c) => c.length)).toBe(1);
    const card = await p.$eval(".link-card-box", (e) => e.textContent ?? "");
    expect(card).toContain("Acme Tiles");
    expect(card).toContain("Supplier");
    expect(card).toContain("Tiles");
    expect(card).toContain("01234 567890");
    // Turning cards off for the type leaves a plain link.
    const supplier = (await api(`/vaults/${vaultId}/types`)).types.find((t: any) => t.name === "Supplier");
    await fetch(`${BASE}/api/vaults/${vaultId}/types/Supplier`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ icon: supplier.icon, colour: supplier.colour, properties: supplier.properties, cards: false }) });
    await until(async () => (await p.$$(".link-card-box")).length === 0, 8000);
    await p.close();
  });
});

describe("small wins", () => {
  beforeAll(freshBrowser);
  test("Tasks: every open to-do in one list; ticking one ticks it in its note", async () => {
    const n = await note("Errands.md", "# Errands\n\n- [ ] Post the parcel 📅 2026-01-02\n- [x] Buy stamps\n");
    const p = await open(`/v/${vaultId}/tasks`);
    await p.waitForSelector(".task-list li");
    const texts = await p.$$eval(".task-list li .task-text", (l) => l.map((e) => e.textContent));
    expect(texts).toContain("Post the parcel");
    expect(texts).not.toContain("Buy stamps"); // Open is the default
    expect(await p.evaluate(() => [...document.querySelectorAll(".task-list li")].find((l) => l.textContent?.includes("Post the parcel"))!.querySelector(".due.overdue")?.textContent)).toBe("2 Jan");
    await p.evaluate(() => ([...document.querySelectorAll(".task-list li")].find((l) => l.textContent?.includes("Post the parcel"))!.querySelector("input") as HTMLInputElement).click());
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("- [x] Post the parcel"), 8000);
    await p.close();
  });

  test("bookmarks: ⋯ → Bookmark puts the note at the top of the sidebar", async () => {
    const n = await note("Starred.md", "# Starred\n");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Bookmark")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".shortcuts .type-row")].some((b) => b.textContent?.includes("Starred")));
    await p.click('button[aria-label="More"]');
    expect(await p.$$eval(".menu-item", (m) => m.map((e) => e.textContent))).toContain("Remove bookmark");
    await p.keyboard.press("Escape");
    await p.close();
  });

  test("History shows what restoring a version would change, and restores it", async () => {
    const n = await note("Hist/Boiler log.md", "# Boiler log\n\nService booked.\nEngineer: Sam.\n");
    await api(`/vaults/${vaultId}/notes/${n.id}/content`, { content: "# Boiler log\n\nService done.\nEngineer: Sam.\nParts: valve.\n" }, "PUT");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("version history");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Version history"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".history-list button");
    await p.click(".history-list button");
    await p.waitForSelector(".history-preview .diff");
    const diff = await p.$eval(".history-preview .diff", (e) => e.textContent ?? "");
    expect(diff).toContain("+ Service booked.");
    expect(diff).toContain("− Service done.");
    expect(diff).toContain("− Parts: valve.");
    expect(await p.$eval(".history-head small", (e) => e.textContent)).toBe("Restoring brings back 1 line and takes away 2 lines");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".history-head button")].find((b) => b.textContent === "Full text")!.click());
    expect(await p.$eval(".history-preview pre", (e) => e.textContent)).toContain("Service booked.\nEngineer: Sam.");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".history-preview button")].find((b) => b.textContent === "Restore this version")!.click());
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("Service booked."));
    await p.close();
  });

  test("saved searches: Save keeps a search in the sidebar; it runs again from there, and × removes it", async () => {
    await note("Saved/Heat pump quote.md", "# Heat pump quote\n\nAir source, 8 kW.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Search"))!.click());
    await p.waitForSelector(".search-panel input");
    await p.type(".search-panel input", "air source");
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Heat pump quote"));
    await p.click(".search-save");
    await p.waitForSelector(".search-save.on");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Files"))!.click());
    await p.waitForSelector(".saved-search");
    expect(await p.$eval(".saved-search .type-row-name", (e) => e.textContent)).toBe("air source");
    await p.click(".saved-search .type-row");
    await p.waitForFunction(() => (document.querySelector(".search-panel input") as HTMLInputElement | null)?.value === "air source");
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Heat pump quote"));
    expect(await api(`/vaults/${vaultId}/searches`)).toEqual([expect.objectContaining({ query: "air source" })]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Files"))!.click());
    await p.waitForSelector(".saved-search-x");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>(".saved-search-x")!.click());
    await p.waitForFunction(() => !document.querySelector(".saved-search"));
    expect(await api(`/vaults/${vaultId}/searches`)).toEqual([]);
    await p.close();
  });

  test("focus mode: ⌘K turns it on, only the text shows, typing works, and Escape leaves it", async () => {
    const n = await note("Focus/Draft.md", "# Draft\n\n" + Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join("\n") + "\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("focus mode");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Focus mode"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".app.focus-mode");
    await Bun.sleep(400); // the panels slide away
    expect(await p.$eval(".sidebar", (e) => getComputedStyle(e).visibility)).toBe("hidden");
    // Typewriter scrolling: the cursor's line sits near the middle of the screen.
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(" The end.");
    await Bun.sleep(200);
    const mid = await p.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const s = document.querySelector(".cm-scroller")!.getBoundingClientRect();
      return Math.abs(r.top - (s.top + s.height / 2)) / s.height;
    });
    expect(mid).toBeLessThan(0.15);
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("The end."));
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector(".app.focus-mode"));
    expect(await p.evaluate(() => localStorage.getItem("cp:focus"))).toBe("0");
    await p.close();
  });

  test("Turn into a typed note: a line becomes a note of a type, with a link left in its place", async () => {
    await note("Types/Contact.md", "---\nicon: user\nproperties:\n  - name: phone\n    kind: text\n---\n# {{title}}\n\n## Notes\n");
    const n = await note("Typed/Monday.md", "# Monday\n\n- Ring the plumber\n- Priya Patel\n");
    const p = await openNote(n.id);
    await (await p.evaluateHandle(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes("Priya Patel"))) as any).click();
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("turn into typed");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Turn into a typed note"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("contact");
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Priya Patel.md"));
    const made = (await api(`/vaults/${vaultId}/notes`)).find((x: any) => x.path === "Priya Patel.md");
    expect((await api(`/vaults/${vaultId}/notes/${made.id}`)).content).toContain("type: Contact");
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("- [[Priya Patel]]\n"));
    expect((await api(`/vaults/${vaultId}/notes/${n.id}`)).content).toContain("- Ring the plumber\n");
    await p.close();
  });

  test("an empty vault offers a short tour; it opens at Start here", async () => {
    const v = await api("/vaults", { name: "Brand new" });
    const p = await open(`/v/${v.id}`);
    await p.waitForSelector(".tour-offer button");
    await p.click(".tour-offer button");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Find your way"));
    expect(await p.$eval(".note-title", (e) => e.textContent)).toBe("Start here");
    await p.close();
  });

  test("unlinked mentions: Link turns the words into a link here", async () => {
    const target = await note("Allotment.md", "# Allotment\n");
    const src = await note("Weekend.md", "Spent Saturday at the allotment.\n");
    const p = await openNote(target.id);
    if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Links"))?.click());
    await p.waitForSelector(".mention-list li");
    await p.click(".mention-link");
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${src.id}`)).content as string) === "Spent Saturday at the [[Allotment|allotment]].\n", 8000);
    await p.close();
  });

  test("following a link to a missing note offers its types: create it as a Person", async () => {
    const n = await note("Who.md", "# Who\n\nMet [[Morgan Lee]] today.\n");
    const p = await openNote(n.id);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview a.internal-link.unresolved");
    await p.click(".preview a.internal-link.unresolved");
    await p.waitForSelector("[data-dialog-input]");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Create “Morgan Lee”");
    await p.keyboard.type("Person");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Morgan Lee.md"));
    const made = ((await api(`/vaults/${vaultId}/notes`)) as any[]).find((x) => x.path === "Morgan Lee.md");
    expect(made.type).toBe("Person");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });
});

describe("weblinks", () => {
  beforeAll(freshBrowser);
  const page = Bun.serve({
    port: 3287,
    fetch: () => new Response(`<head><meta property="og:title" content="A Good Read"><meta property="og:description" content="Worth the time."></head>`, { headers: { "content-type": "text/html" } }),
  });
  afterAll(() => page.stop(true));
  test("⌘K → Save a web link makes a Weblink note with the page's title and summary", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".vault-home");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("save a web link");
    await p.keyboard.press("Enter");
    await answer(p, "http://localhost:3287/read");
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Worth the time."));
    expect(await p.$eval(".type-chip", (e) => e.textContent?.trim())).toBe("Weblink");
    await p.close();
  });
});

describe("offline on the iPhone (F4)", () => {
  beforeAll(freshBrowser);
  test("with the server gone, the app opens from this device, takes edits, keeps them across a reload, and syncs when it's back", async () => {
    const step = (m: string) => process.env.UI_DEBUG && console.log("offline step:", m);
    const n = await note("Offline.md", "# Offline\n\nWritten online.\n");
    const p = await openNote(n.id, true);
    // The first visit installs the service worker; the next load is the one it controls and caches.
    await p.evaluate(async () => void (await navigator.serviceWorker.ready));
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(() => p.evaluate(() => !!navigator.serviceWorker.controller));
    await until(async () => (await content(p)).includes("Written online."));
    await Bun.sleep(800); // the note's copy reaches IndexedDB

    step("server stopping");
    serverDown = true;
    // The network going, not a tidy shutdown: the server is simply gone (its note saved already).
    server.kill("SIGKILL");
    await server.exited;
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Written online."));
    await until(() => p.$eval(".cm-content", (e) => e.getAttribute("contenteditable") === "true"));
    await p.tap(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(" Typed on the train.");
    await Bun.sleep(500);
    step("typed offline");
    await p.reload({ waitUntil: "load" }); // closing and reopening the app with no signal
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Typed on the train."));

    step("reopened offline");
    server = startServer();
    await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok ?? false, 20000);
    step("server back");
    serverDown = false;
    let last = "";
    await until(async () => {
      const c = (await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string;
      if (process.env.UI_DEBUG && c !== last) step(`server has: ${JSON.stringify(c)}; page shows: ${JSON.stringify(await content(p).catch((e) => String(e)))}; status: ${await p.$eval(".conn", (e) => e.className).catch(() => "?")}`);
      last = c;
      return c.includes("Typed on the train.");
    }, 20000);
    expect(((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).match(/Written online\./g)!.length).toBe(1); // merged, not duplicated
    await p.close();
  }, 60000);
});

describe("accessibility (axe)", () => {
  // WCAG 2.1 A and AA, on the main screens, laptop and iPhone, light and dark. Serious and
  // critical problems fail; A11Y_REPORT=1 prints every finding.
  const AXE = Bun.file(require.resolve("axe-core/axe.min.js")).text();
  async function audit(p: Page, where: string, scope?: string) {
    if (!(await p.evaluate(() => "axe" in window))) await p.evaluate(await AXE); // through the debugger, not an inline <script>: the app's CSP allows none
    const found = (await p.evaluate(
      (sel) =>
        (window as any).axe
          .run(sel ? document.querySelector(sel) : document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
          .then((r: any) => r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n: any) => n.target.join(" ") + (n.any?.[0]?.data?.contrastRatio ? ` [${n.any[0].data.fgColor} on ${n.any[0].data.bgColor} = ${n.any[0].data.contrastRatio}, need ${n.any[0].data.expectedContrastRatio}]` : "")) }))),
      scope ?? null,
    )) as { id: string; impact: string; help: string; nodes: string[] }[];
    if (process.env.A11Y_REPORT) for (const v of found) console.log(`[${where}] ${v.impact} ${v.id}: ${v.help} — ${v.nodes.join(" | ")}`);
    return found.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} (${v.nodes.join(" | ")})`);
  }

  test("the main screens have no serious problems, on the laptop and the iPhone, light and dark", async () => {
    await freshBrowser();
    const n = await note("A11y/Kitchen plan.md", "---\nstatus: in progress\nbudget: 7500\ntags: [home]\n---\n# Kitchen plan\n\nSee [[Pancakes]].\n\n- [ ] Choose tiles\n- [x] Get quotes\n\n| Item | Cost |\n|---|---:|\n| Units | £4,200 |\n\n> [!tip] Decision\n> Quartz.\n");
    await note("Types/Gadget.md", "---\nicon: box\nproperties:\n  - name: price\n    kind: number\n---\n# {{title}}\n").catch(() => {});
    await note("A11y/Kettle.md", "---\ntype: Gadget\nprice: 30\n---\n# Kettle\n");
    const problems: string[] = [];
    for (const phone of [false, true]) {
      for (const scheme of ["light", "dark"] as const) {
        const tag = `${phone ? "iPhone" : "laptop"} ${scheme}`;
        const p = await open(`/v/${vaultId}`, phone);
        await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await p.waitForSelector(phone ? ".vault-home, main" : ".tree-row");
        problems.push(...(await audit(p, `${tag} vault home`)));
        await p.goto(`${BASE}/v/${vaultId}/n/${n.id}`);
        await p.waitForSelector(".cm-content");
        await Bun.sleep(300);
        problems.push(...(await audit(p, `${tag} note`)));
        await p.goto(`${BASE}/v/${vaultId}/t/Gadget`);
        await p.waitForFunction(() => document.body.innerText.includes("Kettle"));
        problems.push(...(await audit(p, `${tag} type page`)));
        await p.goto(`${BASE}/v/${vaultId}/tasks`);
        await p.waitForFunction(() => document.body.innerText.includes("Choose tiles"));
        problems.push(...(await audit(p, `${tag} tasks`)));
        if (!phone) {
          await p.keyboard.down("Meta");
          await p.keyboard.press("k");
          await p.keyboard.up("Meta");
          await p.waitForSelector(".palette");
          await Bun.sleep(400); // after it fades in
          problems.push(...(await audit(p, `${tag} command palette`, ".palette")));
          await p.keyboard.press("Escape");
        }
        await p.close();
      }
    }
    // Settings, each section, on the laptop in both themes.
    for (const scheme of ["light", "dark"] as const) {
      const p = await open(`/v/${vaultId}`);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.waitForSelector(".tree-row");
      await p.click('[aria-label="Settings"]');
      await p.waitForSelector(".settings-nav");
      for (const label of ["Account", "This vault", "Website", "AI assistants", "Connections", "Admin"]) {
        const b = await p.evaluateHandle((l) => [...document.querySelectorAll(".settings-nav button")].find((x) => x.textContent?.startsWith(l)), label);
        if (!(await (b as any).evaluate((x: unknown) => !!x))) continue;
        await (b as any).click();
        await Bun.sleep(300);
        problems.push(...(await audit(p, `laptop ${scheme} Settings → ${label}`, ".modal")));
      }
      await p.close();
    }
    // An empty vault, with the tour on offer.
    const empty = await api("/vaults", { name: "Empty for axe" });
    for (const scheme of ["light", "dark"] as const) {
      const p = await open(`/v/${empty.id}`);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.waitForSelector(".tour-offer");
      problems.push(...(await audit(p, `laptop ${scheme} empty vault`)));
      await p.close();
    }
    // Signed out: the sign-in page.
    const ctx = await browser.createBrowserContext(); // no session cookie
    const out = await ctx.newPage();
    await out.goto(`${BASE}/`);
    await out.waitForSelector("input[type=email], input[type=password]");
    problems.push(...(await audit(out, "sign-in")));
    await ctx.close();
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe("website (F18)", () => {
  const button = (p: Page, text: string) => p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === t)!.click(), text);
  const status = (url: string) => fetch(url).then((r) => r.status);

  test("choose a folder, see what will be public, publish, read the pages, take the site down and undo", async () => {
    await freshBrowser();
    const sv = (await api("/vaults", { name: "Our garden" })).id;
    await api(`/vaults/${sv}/notes`, { path: "Garden/Roses.md", content: "# Roses\n\nPrune them in [[Winter jobs]], but [[Secret|not this]].\n\n> [!tip] Feed\n> Monthly.\n\n- [x] Mulch\n" });
    await api(`/vaults/${sv}/notes`, { path: "Garden/Winter jobs.md", content: "## Mulch\n\nSpread it thick." });
    await api(`/vaults/${sv}/notes`, { path: "Private/Secret.md", content: "Not for the web." });

    const p = await open(`/v/${sv}`);
    await p.waitForSelector(".tree-row");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("publish website");
    await p.waitForFunction(() => document.querySelector(".palette .palette-title")?.textContent === "Publish as a website");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("3 notes and 0 files"));

    await p.click(".site-choice label:nth-child(2) input");
    await p.waitForSelector(".site-folders");
    await p.evaluate(() => [...document.querySelectorAll<HTMLLabelElement>(".site-folders label")].find((l) => l.textContent?.trim() === "Garden")!.click());
    await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("2 notes and 0 files"));
    await button(p, "Publish");
    await p.waitForSelector(".site-live a");
    const url = await p.$eval(".site-live a", (a) => (a as HTMLAnchorElement).href);
    expect(await p.$eval(".modal", (e) => e.textContent)).toContain("Nothing has changed since you published.");

    // The site, as a reader sees it: no script, so the page is read as it is served.
    const site = await open(url.replace(BASE, "") + "Garden/Roses");
    expect(await site.$eval("h1", (e) => e.textContent)).toBe("Roses");
    expect(await site.$eval(".callout-title", (e) => e.textContent)).toBe("Feed");
    expect(await site.$eval("main", (e) => e.textContent)).toContain("not this");
    expect(await site.$$eval("main a", (as) => as.map((a) => a.textContent))).toEqual(["Winter jobs"]);
    expect(await site.$eval("body", (e) => getComputedStyle(e).fontFamily)).toContain("apple-system"); // the theme loaded
    await Promise.all([site.waitForNavigation(), site.click("main a.internal-link")]);
    expect(await site.$eval("h1", (e) => e.textContent)).toBe("Winter jobs");
    await site.click(".site-head nav a");
    await site.waitForFunction(() => document.querySelector("h1")?.textContent === "All pages");
    expect(await site.$eval("main", (e) => e.textContent)).not.toContain("Secret");
    await site.close();

    await button(p, "Take the site down");
    await until(async () => (await status(url)) === 404);
    await clickToast(p, "Undo");
    await until(async () => (await status(url)) === 200);
    await p.waitForFunction(() => !!document.querySelector(".site-live a"));
    await p.close();
  });

  test("the published pages have no serious accessibility problems, laptop and iPhone, light and dark", async () => {
    const [v] = ((await api("/vaults")) as { id: number; name: string }[]).filter((x) => x.name === "Our garden");
    const { site } = await api(`/vaults/${v!.id}/site`);
    const AXE = await Bun.file(require.resolve("axe-core/axe.min.js")).text();
    const problems: string[] = [];
    for (const phone of [false, true]) {
      for (const scheme of ["light", "dark"] as const) {
        for (const path of ["", "Garden/Roses"]) {
          opened++;
          const page = await browser.newPage();
          await page.setBypassCSP(true); // to run axe in a page that allows no script
          await page.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1200, height: 850 });
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
          await page.goto(`${BASE}/p/${site.slug}/${path}`);
          await page.addScriptTag({ content: AXE });
          const found = await page.evaluate(() =>
            (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }).then((r: any) => r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => `${v.id} (${v.nodes.slice(0, 3).map((n: any) => n.target.join(" ")).join(" | ")})`)),
          );
          problems.push(...found.map((f: string) => `${phone ? "iPhone" : "laptop"} ${scheme} /${path}: ${f}`));
          if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          await page.close();
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("review fixes (N13, client)", () => {
  beforeAll(freshBrowser);
  const searchTab = (p: Page) =>
    p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Search"))!.click());
  const dbNames = (p: Page) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
  const clearBox = async (p: Page, sel: string) => {
    await p.$eval(sel, (e) => (e as HTMLInputElement).select());
    await p.keyboard.press("Backspace");
  };

  test("someone else signing in on this browser doesn't get the last person's offline copies; the same person keeps theirs", async () => {
    const me = (await api("/session")).user.id as number;
    const instance = (await api("/session")).instance as string;
    const n = await note("Private/Diary.md", "# Diary\n\nMine alone.\n");
    const r = await fetch(`${BASE}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "other@example.com", password: "password-other", name: "Other" }),
    });
    const otherCookie = r.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const ctx = await browser.createBrowserContext(); // a browser of its own: nothing left from other tests
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await p.setViewport({ width: 1200, height: 850 });
    // Copies from before they were named by person, and a cached read: nobody can say whose they are.
    await p.goto(`${BASE}/health`);
    await p.evaluate(async (legacy) => {
      await new Promise((ok) => (indexedDB.open(legacy).onsuccess = ok));
      await (await caches.open("cp-api-v1")).put("/api/vaults/999/notes", new Response("[]"));
    }, `cp-${instance}-${n.id}`);
    await p.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
    await p.goto(`${BASE}/v/${vaultId}/n/${n.id}`, { waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Mine alone."));
    const mine = `cp-${instance}-u${me}-${n.id}`;
    await until(async () => {
      const names = await dbNames(p);
      return names.includes(mine) && !names.includes(`cp-${instance}-${n.id}`);
    });
    expect(await p.evaluate(async () => !!(await (await caches.open("cp-api-v1")).match("/api/vaults/999/notes")))).toBe(false);

    // The same person coming back keeps their copy.
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await Bun.sleep(300);
    expect(await dbNames(p)).toContain(mine);

    // Their session ends, and someone else signs in here: the first person's copies go.
    await p.setCookie({ name: "cp_session", value: otherCookie, url: BASE });
    await p.goto(`${BASE}/`, { waitUntil: "load" });
    await p.waitForSelector(".sidebar");
    await until(async () => !(await dbNames(p)).some((d) => d.includes(`-u${me}-`)));
    await ctx.close();
  });

  test("search: clearing the box mid-debounce or mid-request clears it for good; a failed search says so and can try again", async () => {
    await note("Search fixes/Boiler service.md", "# Boiler service\n\nAnnual check of the combi boiler.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await searchTab(p);
    await p.waitForSelector(".search-panel input");
    const meta = () => p.$eval(".search-meta span", (e) => e.textContent ?? "");
    const hits = () => p.$$eval(".search-results li", (l) => l.length);

    // Cleared before the debounce fires: not stuck on "Searching…".
    await p.type(".search-panel input", "combi");
    await clearBox(p, ".search-panel input");
    await Bun.sleep(400);
    expect(await meta()).not.toContain("Searching");

    // A slow reply to a search that's been cleared doesn't bring its results back.
    let mode: "slow" | "fail" | "pass" = "slow";
    let asked = 0;
    await p.setRequestInterception(true);
    p.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (!req.url().includes("/search?")) return void req.continue();
      asked++;
      if (mode === "slow") return void setTimeout(() => void req.continue().catch(() => {}), 900);
      if (mode === "fail") return void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Search is resting for a moment." }) });
      void req.continue();
    });
    await p.type(".search-panel input", "combi");
    await until(() => asked > 0);
    await clearBox(p, ".search-panel input");
    await Bun.sleep(1300);
    expect(await hits()).toBe(0);
    expect(await meta()).not.toContain("Searching");

    // A failed search shows why, with a way to try again.
    serverDown = true; // the refused request is expected here
    mode = "fail";
    await p.type(".search-panel input", "combi");
    await p.waitForFunction(() => document.querySelector(".search-error")?.textContent?.includes("Search is resting for a moment."));
    expect(await meta()).toBe("Couldn't search");
    mode = "pass";
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".search-error button")].find((b) => b.textContent === "Try again")!.click());
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Boiler service"));
    expect(await p.$(".search-error")).toBeNull();
    serverDown = false;
    await p.close();
  });

  test("the links panel starts empty for each note, and says when its links couldn't load", async () => {
    const a = await note("Links fixes/Alpha.md", "# Alpha\n\nSee [[Beta]].\n");
    const b = await note("Links fixes/Beta.md", "# Beta\n\nNothing here.\n");
    const p = await openNote(a.id);
    await p.waitForFunction(() => document.querySelector(".links-panel")?.textContent?.includes("Links fixes/Beta"));
    serverDown = true;
    await p.setBypassServiceWorker(true); // the worker would fetch the links itself, past the interception
    await p.setRequestInterception(true);
    p.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (/\/notes\/\d+\/links$/.test(new URL(req.url()).pathname)) return void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The server is busy." }) });
      void req.continue();
    });
    await p.evaluate((u) => (history.pushState(null, "", u), dispatchEvent(new PopStateEvent("popstate"))), `/v/${vaultId}/n/${b.id}`);
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Beta");
    // Alpha's outgoing link must not stay up as Beta's.
    expect(await p.$eval(".links-panel", (e) => e.textContent ?? "")).not.toContain("Links fixes/Beta");
    await p.waitForFunction(() => document.querySelector(".links-panel")?.textContent?.includes("Couldn't load this note's links. The server is busy."));
    serverDown = false;
    await p.close();
  });

  test("keyboard: folder rows open and close, the title renames, and the quick switcher keeps and returns focus", async () => {
    await note("Keyfolder/Inside note.md", "# Inside note\n");
    const n = await note("Keyfolder/Renamed by keys.md", "Text.\n"); // no heading: the title is the file's name
    const p = await openNote(n.id);
    const toggle = 'button.tree-toggle[aria-expanded]';
    const expanded = () => p.evaluate(() => [...document.querySelectorAll(".tree-toggle")].find((b) => b.textContent === "Keyfolder")?.getAttribute("aria-expanded"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".tree-toggle")].find((b) => b.textContent === "Keyfolder")!.focus());
    expect(await p.evaluate((s) => document.activeElement?.matches(s), toggle)).toBe(true);
    const was = await expanded();
    await p.keyboard.press("Enter");
    await until(async () => (await expanded()) !== was);
    await p.keyboard.press("Space");
    await until(async () => (await expanded()) === was);

    // The title: a focusable button named for what it does; Enter renames, and focus comes back.
    expect(await p.$eval(".note-title .title-button", (e) => e.getAttribute("aria-label"))).toBe("Rename “Renamed by keys”");
    await p.focus(".note-title .title-button");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-input"));
    await p.$eval(".title-input", (e) => (e as HTMLInputElement).select());
    await p.keyboard.type("Renamed with keys");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Renamed with keys");
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-button"));

    // ⌘O: a modal that keeps Tab inside, and Escape puts focus back where it was.
    await p.keyboard.down("Meta");
    await p.keyboard.press("o");
    await p.keyboard.up("Meta");
    await p.waitForSelector('.switcher[role="dialog"][aria-modal="true"] input');
    await p.waitForFunction(() => document.activeElement?.matches(".switcher input"));
    for (let i = 0; i < 5; i++) {
      await p.keyboard.press("Tab");
      expect(await p.evaluate(() => !!document.activeElement?.closest(".switcher"))).toBe(true);
    }
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector(".switcher"));
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-button"));
    expect((await api(`/vaults/${vaultId}/notes/${n.id}`)).path).toBe("Keyfolder/Renamed with keys.md");
    await p.close();
  });
});

describe("keyboard only", () => {
  test("find a note, edit it, open Settings and get back, without the mouse; Tab stays inside a dialog", async () => {
    await freshBrowser();
    await note("Keys/Keyboard note.md", "# Keyboard note\n\nStart.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    const press = async (key: string, mod?: "Meta" | "Shift") => {
      if (mod) await p.keyboard.down(mod);
      await p.keyboard.press(key as any);
      if (mod) await p.keyboard.up(mod);
    };
    await press("o", "Meta");
    await p.waitForSelector(".switcher input");
    await p.keyboard.type("Keyboard note");
    await p.waitForFunction(() => document.querySelector('.switcher [aria-selected="true"]')?.textContent?.includes("Keyboard note"));
    await press("Enter");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Start."));
    await p.waitForFunction(() => document.activeElement?.classList.contains("cm-content"));
    await press("End", "Meta");
    await p.keyboard.type(" Typed.");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Start. Typed."));
    await press("k", "Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("Account settings");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Account"));
    await press("Enter");
    await p.waitForSelector(".settings-nav");
    // Tab round the dialog many times: focus never leaves it.
    for (let i = 0; i < 40; i++) {
      await press("Tab");
      expect(await p.evaluate(() => !!document.activeElement?.closest(".modal"))).toBe(true);
    }
    await press("Tab", "Shift");
    expect(await p.evaluate(() => !!document.activeElement?.closest(".modal"))).toBe(true);
    await press("Escape");
    await p.waitForFunction(() => !document.querySelector(".settings-nav"));
    await p.close();
  });
});

describe("collaboration and home", () => {
  beforeAll(freshBrowser);
  test("two pages edit the same note live", async () => {
    const n = await note("Shared.md", "start");
    const [a, b] = [await openNote(n.id), await openNote(n.id, true)];
    await a.bringToFront(); // headless Chrome stalls input to background tabs
    await a.click(".cm-content");
    await a.keyboard.down("Meta");
    await a.keyboard.press("ArrowDown");
    await a.keyboard.up("Meta");
    await a.keyboard.type(" typed live");
    await until(async () => (await content(b)).includes("start typed live"));
    await a.close();
    await b.close();
  });

  test("a vault with only folders doesn't say it's empty", async () => {
    const v = await api("/vaults", { name: "Folders only" });
    await api(`/vaults/${v.id}/folders`, { path: "Ideas" });
    const p = await open(`/v/${v.id}`);
    await p.waitForFunction(() => /No notes yet|This vault is empty/.test(document.querySelector(".vault-home")?.textContent ?? ""));
    const text = await p.$eval(".vault-home", (e) => e.textContent ?? "");
    expect(text).not.toContain("This vault is empty");
    expect(text).toContain("No notes yet");
    await p.close();
  });

  test("the sidebar toggle and ⌘\\ hide and show the file panel, remembered after a reload", async () => {
    const n = await note("Wide.md", "# Wide");
    const p = await openNote(n.id);
    const shown = () => p.$eval(".sidebar", (e) => getComputedStyle(e).visibility === "visible");
    const noteWidth = () => p.$eval(".main", (e) => e.getBoundingClientRect().width);
    expect(await shown()).toBe(true);
    const before = await noteWidth();
    await p.waitForSelector(".app.ready"); // the panels animate only once the first layout has settled
    // It slides: the column passes through widths between open and closed.
    const widths = await p.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')!.click();
      const out: number[] = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 30));
        out.push(parseFloat(getComputedStyle(document.querySelector(".app")!).getPropertyValue("--left")));
      }
      return out;
    });
    expect(widths.some((w) => w > 1 && w < 271)).toBe(true);
    await until(async () => !(await shown()) && (await noteWidth()) > before + 200);
    expect(await p.$eval('button[aria-label="Files"]', (e) => e.getAttribute("aria-expanded"))).toBe("false");
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    expect(await shown()).toBe(false);
    await p.keyboard.down("Meta");
    await p.keyboard.press("Backslash");
    await p.keyboard.up("Meta");
    await until(shown);
    expect(await p.evaluate(() => localStorage.getItem("cp:left"))).toBe("1");
    await p.close();
  });

  test("no page errors anywhere above", () => {
    expect(errors).toEqual([]);
  });
});

async function rowOfLine(p: Page, text: string) {
  const h = await p.evaluateHandle((t) => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes(t)), text);
  return (h as any).boundingBox() as Promise<{ x: number; y: number; width: number; height: number } | null>;
}
const lineText = (p: Page, text: string) =>
  p.evaluate((t) => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes(t))?.textContent ?? null, text);
