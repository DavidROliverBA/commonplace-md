// Speed at 10,000 notes (backlog N12): builds a vault of 10,000 linked, tagged and typed notes in
// a scratch database, then times the endpoints the app leans on against the budgets below. Exits
// non-zero if any is over budget. Needs the docker database: `bun scripts/bench.ts [notes]`.

import { strToU8, zipSync } from "fflate";
import postgres from "postgres";

const N = Number(process.argv[2] ?? 10_000);
const PORT = 3302;
const BASE = `http://localhost:${PORT}`;
const ADMIN_DB = process.env.BENCH_ADMIN_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB = ADMIN_DB.replace(/\/[^/]+$/, "/commonplace_bench");

/** Median ms allowed per call, on a laptop; production is slower, so these are generous. */
const BUDGET: Record<string, number> = {
  "notes (file tree)": 100, tags: 50, "type page": 100, search: 150, "tag search": 50, suggest: 80, graph: 400,
  tasks: 100, "open note": 30, "note links panel": 100, mentions: 100, resolve: 20,
};

function vault(): Uint8Array {
  const words = "boiler garden kitchen solar heat pump insulation window roof gutter paint fence shed tap radiator loft door floor tile lamp".split(" ");
  const w = (i: number, k: number) => words[(i * 7 + k * 13) % words.length]!;
  const files: Record<string, Uint8Array> = {
    "Types/Person.md": strToU8("---\nicon: user\nproperties:\n  - name: role\n    kind: select\n    options: [owner, trade, friend]\n---\n# {{title}}\n"),
    "Types/Meeting.md": strToU8("---\nicon: calendar\nproperties:\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n# {{title}}\n"),
  };
  for (let i = 0; i < N; i++) {
    const fm =
      i % 10 === 0 ? `---\ntype: Person\nrole: ${["owner", "trade", "friend"][i % 3]}\n---\n`
      : i % 10 === 1 ? `---\ntype: Meeting\nattendees: ["[[Note ${i - 1}]]", "[[Note ${(i * 31) % N}]]"]\n---\n`
      : "";
    const links = [1, 2, 3].map((k) => `[[Note ${(i * 17 + k * 101) % N}]]`).join(", ");
    const body = Array.from({ length: 8 }, (_, k) => `${w(i, k)} ${w(i + 1, k)} ${w(i + 2, k)} notes about the ${w(i, k + 3)}.`).join(" ");
    files[`Area ${i % 40}/Sub ${i % 7}/Note ${i}.md`] = strToU8(`${fm}# Note ${i}\n\n${body}\n\nSee ${links}. #${w(i, 0)} #${w(i, 1)}\n\n- [ ] task ${i}\n`);
  }
  return zipSync(files, { level: 1 });
}

const admin = postgres(ADMIN_DB, { onnotice: () => {} });
await admin.unsafe("drop database if exists commonplace_bench with (force)");
await admin.unsafe("create database commonplace_bench");
const server = Bun.spawn(["bun", "src/server.ts"], {
  env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), SETUP_TOKEN: "bench", EMBEDDING_PROVIDER: process.env.BENCH_EMBED ?? "hash", NODE_ENV: "production", DB_DISK_GB: "0" },
  stdout: "ignore",
  stderr: "inherit",
});
let cookie = "";
const api = async (path: string, init: { body?: unknown; form?: FormData } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.body !== undefined || init.form ? "POST" : "GET",
    headers: { cookie, origin: BASE, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};
let over = 0;
try {
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/health`).catch(() => null))?.ok; i++) await Bun.sleep(100);
  await api("/register", { body: { email: "bench@example.com", password: "bench-password", name: "Bench", setupToken: "bench" } });
  const v = (await api("/vaults", { body: { name: "Bench" } })).id;
  const form = new FormData();
  form.append("files", new File([vault() as Uint8Array<ArrayBuffer>], "vault.zip"));
  let t = performance.now();
  await api(`/vaults/${v}/import`, { form });
  console.log(`import ${N} notes: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const notes: { id: number; path: string }[] = await api(`/vaults/${v}/notes`);
  const n500 = notes.find((n) => n.path.endsWith("/Note 500.md"))!.id;
  const runs: [string, string][] = [
    ["notes (file tree)", `/vaults/${v}/notes`], ["tags", `/vaults/${v}/tags`], ["type page", `/vaults/${v}/types/Person`],
    ["search", `/vaults/${v}/search?q=heat%20pump`], ["tag search", `/vaults/${v}/search?q=%23solar`], ["suggest", `/vaults/${v}/suggest?q=Note%2012`],
    ["graph", `/vaults/${v}/graph`], ["tasks", `/vaults/${v}/tasks`], ["open note", `/vaults/${v}/notes/${n500}`],
    ["note links panel", `/vaults/${v}/notes/${n500}/links`], ["mentions", `/vaults/${v}/notes/${n500}/mentions`], ["resolve", `/vaults/${v}/resolve?target=Note%20777`],
  ];
  console.log(`${"".padEnd(20)} median   budget`);
  for (const [name, path] of runs) {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      await api(path);
      ms.push(performance.now() - t);
    }
    const median = ms.sort((a, b) => a - b)[2]!;
    const ok = median <= BUDGET[name]!;
    if (!ok) over++;
    console.log(`${name.padEnd(20)} ${median.toFixed(0).padStart(5)} ms ${String(BUDGET[name]).padStart(5)} ms ${ok ? "" : " OVER"}`);
  }
} finally {
  server.kill();
  await server.exited;
  await admin.unsafe("drop database if exists commonplace_bench with (force)");
  await admin.end();
}
process.exit(over ? 1 : 0);
