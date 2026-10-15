// Screenshots of the main screens on a laptop and an iPhone, in light and dark, for checking the
// design against docs/PRINCIPLES.md. Not a test: `bun run screens [out-dir]` (default ./screens,
// gitignored). Like the UI tests it needs Chrome and the docker database, on which it drops and
// recreates its own scratch database, `commonplace_screens`.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import puppeteer, { type Page } from "puppeteer-core";
import { startFakeAi } from "../fakeAi";
import { startFakeGitHub, TOKEN } from "../fakeGitHub";
import { chromePath } from "./chrome";

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const ADMIN_DB = process.env.UI_ADMIN_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB = ADMIN_DB.replace(/\/[^/]+$/, "/commonplace_screens");
const OUT = process.argv[2] ?? "screens";
mkdirSync(OUT, { recursive: true });

const admin = postgres(ADMIN_DB, { onnotice: () => {} });
await admin.unsafe("drop database if exists commonplace_screens with (force)");
await admin.unsafe("create database commonplace_screens");
await admin.end();
const fake = startFakeAi(3194);
const fakeGh = startFakeGitHub(3185);
const server = Bun.spawn(["bun", "src/server.ts"], {
  env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), ALLOW_SIGNUP: "true", SETUP_TOKEN: "", EMBEDDING_PROVIDER: "hash", SECRETS_KEY: "screens-key", ALLOW_LOCAL_AI: "true", GITHUB_API_URL: "http://localhost:3185", NODE_ENV: "production" },
  stdout: "ignore",
  stderr: "inherit",
});

try {
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/health`).catch(() => null))?.ok; i++) await Bun.sleep(100);
  const r = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "screens@example.com", password: "password-screens", name: "Sam" }),
  });
  const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  const api = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(`${BASE}/api${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { cookie, "content-type": "application/json", origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const vaultId = (await api("/vaults"))[0].id;
  for (const f of ["Projects", "Projects/Kitchen", "Recipes"]) await api(`/vaults/${vaultId}/folders`, { path: f });
  const contractors = await api(`/vaults/${vaultId}/notes`, { path: "Projects/Contractors.md", content: "# Contractors\n\nBuilders and trades." });
  await api(`/vaults/${vaultId}/notes`, { path: "Diary.md", content: "# Diary\n\nRang the contractors about the worktops.\n\n- [ ] Pay the deposit 📅 2026-10-09\n- [ ] Order tiles 📅 2026-10-30\n" });
  const kitchen = await api(`/vaults/${vaultId}/notes`, {
    path: "Projects/Kitchen/Kitchen plan.md",
    content:
      "---\ntags: [home, kitchen]\nstatus: in progress\nbudget: 7500\ndue: 2026-11-30\n---\n# Kitchen plan\n\nAgreed with [[Contractors|our builders]]: **quartz** worktops, *oak* floor, and ==new lighting==.\n\n> [!tip] Decision\n> Go with the quartz.\n\n## Tasks\n- [x] Get quotes\n- [ ] Choose tiles\n- [ ] Book the electrician\n\n| Item | Cost |\n|---|---:|\n| Units | £4,200 |\n| Worktops | £1,900 |\n",
  });
  await api(`/vaults/${vaultId}/notes`, { path: "Recipes/Pancakes.md", content: "# Pancakes\n\n- 100 g flour\n- 2 eggs\n- 300 ml milk" });
  // Types (F16): People and Meetings, related.
  const personType = await api(`/vaults/${vaultId}/notes`, { path: "Types/Person.md", content: "---\nicon: user\ncolour: blue\nproperties:\n  - name: role\n    kind: select\n    options: [Builder, Electrician, Designer, Friend]\n  - name: company\n    kind: text\n  - name: phone\n    kind: text\n  - name: met\n    kind: date\n---\n# {{title}}\n\n## Notes\n" });
  await api(`/vaults/${vaultId}/notes`, { path: "Types/Meeting.md", content: "---\nicon: calendar\ncolour: amber\nproperties:\n  - name: date\n    kind: date\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n# {{title}}\n\n## Agenda\n\n## Actions\n" });
  for (const [name, role, company, phone] of [["Sam Okafor", "Builder", "Okafor & Sons", "07700 900123"], ["Priya Shah", "Designer", "Shah Interiors", "07700 900456"], ["Tom Reed", "Electrician", "Reed Electrical", ""]])
    await api(`/vaults/${vaultId}/notes`, { path: `People/${name}.md`, content: `---\ntype: Person\nrole: ${role}\ncompany: ${company}\n${phone ? `phone: ${phone}\n` : ""}---\n# ${name}\n` });
  const kickoff = await api(`/vaults/${vaultId}/notes`, { path: "Meetings/Kitchen kickoff.md", content: '---\ntype: Meeting\ndate: 2026-10-08\nattendees:\n  - "[[Sam Okafor]]"\n  - "[[Priya Shah]]"\n---\n# Kitchen kickoff\n\n## Agenda\n- Worktops\n- Lighting\n' });
  const overview = await api(`/vaults/${vaultId}/notes`, { path: "Projects/Kitchen/Overview.md", content: "# Kitchen overview\n\nThe builder:\n\n[[Sam Okafor]]\n\nWhat's left, from the plan:\n\n![[Kitchen plan#Tasks]]\n" });
  await api("/me/assistants", { name: "Claude", provider: "compatible", baseUrl: `${fake.url}/v1`, model: "claude-opus-5-5", apiKey: "screens-fake-key" });
  // One AI exchange: a search, an answer with a link, and a page proposed for approval.
  const aiScript = () =>
    fake.script.push(
      { text: "Let me check your notes.", calls: [{ name: "search_notes", input: { query: "kitchen" } }] },
      {
        text: "Your [[Kitchen plan]] has two tasks left: **choose tiles** and **book the electrician**. Shall I make a checklist page?",
        calls: [{ name: "create_note", input: { path: "Projects/Kitchen/Checklist", content: "# Kitchen checklist\n\n- [ ] Choose tiles\n- [ ] Book the electrician\n\nFrom [[Kitchen plan]].\n" } }],
      },
    );

  // A GitHub vault (F14) with two notes changed.
  await api("/me/github", { token: TOKEN }, "PUT");
  const ghVault = (await api("/vaults/github", { repo: "sam/house", branch: "main", folder: "docs" })).vault.id;
  const ghNotes = (await api(`/vaults/${ghVault}/notes`)) as { id: number; path: string }[];
  const ghBoiler = ghNotes.find((n) => n.path === "Boiler.md")!.id;
  await api(`/vaults/${ghVault}/notes/${ghBoiler}/content`, { content: "# Boiler\n\nServiced in May by Sam Okafor.\n\n- filter\n- pressure\n- flue checked\n" }, "PUT");
  await api(`/vaults/${ghVault}/notes/${ghNotes.find((n) => n.path === "Garden.md")!.id}/content`, { content: "# Garden\n\nPlant bulbs in October.\n" }, "PUT");

  // A published site (F18): Projects and Recipes, then a later edit, so Settings → Website has a
  // change to list.
  await api(`/vaults/${vaultId}/site/settings`, { include: ["Projects", "Recipes"] }, "PUT");
  const { slug } = await api(`/vaults/${vaultId}/site/publish`, {});
  await api(`/vaults/${vaultId}/notes`, { path: "Recipes/Flapjacks.md", content: "# Flapjacks\n\n- oats\n- golden syrup" });

  // A fresh browser for each device and theme: headless Chrome stalls after many pages.
  const launch = () => puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  let browser = await launch();
  const shot = async (p: Page, name: string) => {
    await Bun.sleep(350); // let animations settle
    await p.screenshot({ path: join(OUT, `${name}.png`) });
  };
  for (const device of ["laptop", "phone"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      await browser.close();
      browser = await launch();
      const p = await browser.newPage();
      await p.setViewport(device === "phone" ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 800 });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
      const tag = `${device}-${scheme}`;

      await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
      await p.waitForSelector(".vault-home");
      await shot(p, `${tag}-1-home`);

      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(800);
      await shot(p, `${tag}-2-note`);

      await p.click('button[aria-label="More"]');
      await p.waitForSelector(".menu");
      await shot(p, `${tag}-3-menu`);
      await p.keyboard.press("Escape");

      // The / menu, at the end of the note.
      await p.click(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("ArrowDown");
      await p.keyboard.up("Meta");
      await p.keyboard.press("Enter");
      await p.keyboard.type("/");
      await p.waitForSelector(".cm-tooltip-autocomplete");
      await shot(p, `${tag}-3b-slash`);
      await p.keyboard.press("Escape");

      // The block handle (F12): by the hovered block on a laptop, the cursor's on a phone; its menu.
      const row = await p.evaluate(() => {
        const r = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes("Choose tiles"))!.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2 };
      });
      if (device === "phone") await p.touchscreen.tap(row.x, row.y);
      else await p.mouse.move(row.x, row.y);
      await p.waitForSelector(".cm-block-handle:not([hidden])");
      await shot(p, `${tag}-3d-handle`);
      await p.click(".cm-block-grip");
      await p.waitForSelector(".menu");
      await shot(p, `${tag}-3e-block-menu`);
      if (device === "phone") await p.click(".menu-cancel");
      else await p.keyboard.press("Escape");
      await p.keyboard.press("Backspace");
      await p.keyboard.press("Backspace");
      if (device === "laptop") {
        await p.keyboard.down("Meta");
        await p.keyboard.press("k");
        await p.keyboard.up("Meta");
        await p.waitForSelector(".palette li");
        await shot(p, `${tag}-3c-palette`);
        await p.keyboard.press("Escape");
        // Both panels hidden (F15), then back.
        await p.click('button[aria-label="Files"]');
        await p.click('button[aria-label="Side panel"]');
        await Bun.sleep(400);
        await shot(p, `${tag}-2b-focus`);
        await p.click('button[aria-label="Files"]');
        await p.click('button[aria-label="Side panel"]');
        await Bun.sleep(400);
        // Focus mode: only the text.
        await p.evaluate(() => localStorage.setItem("cp:focus", "1"));
        await p.reload({ waitUntil: "load" });
        await p.waitForSelector(".app.focus-mode .cm-content");
        await Bun.sleep(600);
        await shot(p, `${tag}-2c-focus-mode`);
        await p.evaluate(() => localStorage.setItem("cp:focus", "0"));
        await p.reload({ waitUntil: "load" });
        await p.waitForSelector(".cm-content");
        await Bun.sleep(400);
      }

      // The AI: the side panel with a change to approve, then the @name box (a sheet on a phone).
      if (device === "laptop") {
        await p.keyboard.down("Meta");
        await p.keyboard.press("j");
        await p.keyboard.up("Meta");
      } else {
        await p.click('button[aria-label="Side panel"]');
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("AI"))?.click());
      }
      const box = await p.waitForSelector(".ai-panel textarea");
      aiScript();
      await box!.click();
      await p.keyboard.type("What's left on the kitchen?");
      await p.keyboard.press("Enter");
      await p.waitForSelector(".ai-change");
      await shot(p, `${tag}-8-ai-panel`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Discard")!.click());
      await Bun.sleep(300);
      if (device === "phone") await p.click('button[aria-label="Close the side panel"]');
      else {
        await p.keyboard.down("Meta");
        await p.keyboard.press("j");
        await p.keyboard.up("Meta");
      }
      await p.click(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("ArrowDown");
      await p.keyboard.up("Meta");
      await p.keyboard.press("Enter");
      await p.keyboard.type("@Cl");
      await p.waitForSelector(".cm-tooltip-autocomplete");
      await shot(p, `${tag}-8b-mention`);
      await Bun.sleep(150);
      await p.keyboard.press("Enter");
      await p.waitForSelector(".ai-chat textarea");
      fake.script.push({ text: "Quartz worktops, an oak floor and new lighting, agreed with [[Contractors]]." });
      await p.keyboard.type("Summarise the decisions");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => [...document.querySelectorAll(".ai-reply")].some((e) => e.textContent?.includes("Quartz")));
      await shot(p, `${tag}-8c-inline`);
      await p.click('button[aria-label="Discard"]');

      // Types: a type page, and a typed note with its chip and properties.
      await p.goto(`${BASE}/v/${vaultId}/t/Person`, { waitUntil: "load" });
      await p.waitForSelector(".type-table, .type-cards, .type-list");
      await shot(p, `${tag}-10-type-page`);
      await p.goto(`${BASE}/v/${vaultId}/tasks`, { waitUntil: "load" });
      await p.waitForSelector(".task-list li");
      await shot(p, `${tag}-12-tasks`);
      if (device === "laptop") {
        await p.goto(`${BASE}/v/${vaultId}/n/${contractors.id}`, { waitUntil: "load" });
        await p.waitForSelector(".cm-content");
        if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
        await p.waitForSelector(".right-tabs [role=tab]");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Links"))?.click());
        await p.waitForSelector(".mention-list li");
        await shot(p, `${tag}-12b-mentions`);
      }
      // GitHub vault: the branch bar on a note, the changes page with a diff, the PR form.
      await p.goto(`${BASE}/v/${ghVault}/n/${ghBoiler}`, { waitUntil: "load" });
      await p.waitForSelector(".branch-count");
      await Bun.sleep(400);
      await shot(p, `${tag}-13-branch-bar`);
      await p.goto(`${BASE}/v/${ghVault}/changes`, { waitUntil: "load" });
      await p.waitForSelector(".change-edited");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".change-edited button")].find((b) => b.textContent === "Diff")?.click());
      await p.waitForSelector(".change .diff");
      await shot(p, `${tag}-13b-changes`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".changes-page button.primary")].pop()?.click());
      await p.waitForSelector(".pr-form");
      await shot(p, `${tag}-13c-pull-request`);
      await p.keyboard.press("Escape");

      await p.goto(`${BASE}/v/${vaultId}/n/${overview.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-lp-embed .note-embed-body li");
      await p.waitForSelector(".link-card-box");
      await shot(p, `${tag}-11-embed-card`);
      await p.goto(`${BASE}/v/${vaultId}/n/${personType.id}`, { waitUntil: "load" });
      await p.waitForSelector(".type-editor .type-prop");
      await shot(p, `${tag}-10c-type-editor`);
      if (device === "laptop") {
        await p.click('button[aria-label="New type"]');
        await p.waitForSelector(".starters");
        await shot(p, `${tag}-10d-new-type`);
        await p.keyboard.press("Escape");
      }
      await p.goto(`${BASE}/v/${vaultId}/n/${kickoff.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(800);
      await shot(p, `${tag}-10b-typed-note`);
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(500);

      if (device === "phone") {
        await p.click('button[aria-label="Files"]');
        await Bun.sleep(400);
      }
      await p.waitForSelector(".tree-row.folder");
      await shot(p, `${tag}-4-files`);
      await p.evaluate(() => document.querySelector<HTMLButtonElement>('.sidebar-actions button[aria-label="New folder"]')?.click());
      await p.waitForSelector("[data-dialog-input]");
      await shot(p, `${tag}-5-dialog`);
      await p.keyboard.press("Escape");

      await p.evaluate(() => document.querySelector<HTMLButtonElement>('.sidebar-actions button[title^="New note"]')?.click());
      await p.waitForSelector(".cm-content");
      await Bun.sleep(600);
      if (device === "phone") await p.evaluate(() => document.querySelector<HTMLElement>(".scrim")?.click());
      await p.click('button[aria-label="More"]');
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))?.click());
      await p.waitForSelector(".toast");
      await shot(p, `${tag}-6-toast`);

      if (device === "phone") {
        await p.click('button[aria-label="Files"]');
        await Bun.sleep(400);
      }
      await p.click("button.account");
      await p.waitForSelector(".settings-nav");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await p.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].some((b) => b.textContent === "Create token"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create token")!.click());
      await p.waitForSelector(".capture-setup");
      await p.evaluate(() => document.querySelector(".capture-setup")!.scrollIntoView());
      await shot(p, `${tag}-7-share-setup`);
      // Settings (F17): the iPhone's list of sections, the laptop's vault section.
      if (device === "phone") await p.click(".settings-back");
      else await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("This vault"))!.click());
      await Bun.sleep(300);
      await shot(p, `${tag}-7b-settings`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Website"))!.click());
      await p.waitForSelector(".site-live");
      await shot(p, `${tag}-7c-website`);
      await p.keyboard.press("Escape");
      await p.evaluate(() => document.querySelector<HTMLElement>(".modal-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      if (device === "laptop") {
        await p.waitForSelector(".palette input");
        await p.keyboard.type("add an ai");
        await p.keyboard.press("Enter");
        await p.waitForSelector(".assistant-form");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form [role=radio]")].find((b) => b.textContent === "relaxAI")!.click());
        await shot(p, `${tag}-9-boyai`);
      }
      // The published site, as a reader sees it.
      await p.goto(`${BASE}/p/${slug}/Projects/Kitchen/Kitchen%20plan`, { waitUntil: "load" });
      await shot(p, `${tag}-14-site-page`);
      await p.goto(`${BASE}/p/${slug}/`, { waitUntil: "load" });
      await shot(p, `${tag}-14b-site-home`);
      await p.close();
    }
  }
  await browser.close();
  console.log(`Screenshots in ${OUT}/`);
} finally {
  fake.stop();
  fakeGh.stop();
  server.kill();
}
