// Dataview queries (src/dataview.ts): the language, the vault's pages, and the results.

import { describe, expect, test } from "bun:test";
import { inlineQuery, readPage, type Result, runInline, runQuery, Vault } from "../src/dataview";
import { renderResult } from "../src/dataviewRender";

const DAY = Date.UTC(2026, 6, 27, 9, 30); // Monday 27 July 2026, 09:30 UTC
const notes: Record<string, string> = {
  "People/Ada.md": "---\ntype: Person\naliases: [Countess]\n---\n# Ada\n",
  "People/Brian.md": "---\ntype: Person\n---\n# Brian\n",
  "Meetings/Kickoff.md": '---\ntype: Meeting\ndate: 2026-07-20\nattendees: ["[[Ada]]", "[[Brian]]"]\nproject: "[[Apollo]]"\nstatus: done\n---\n# Kickoff\n\n- [ ] Book room #admin\n  - [ ] Ask facilities\n- [x] Send agenda [due:: 2026-07-19]\n',
  "Meetings/Review.md": '---\ntype: Meeting\ndate: 2026-07-27\nattendees: ["[[Countess]]"]\nproject: "[[Apollo]]"\nstatus: open\ntags: [work/review]\n---\n# Review\n\n- [ ] Write notes 📅 2026-07-28\n',
  "Projects/Apollo.md": "---\ntype: Project\nstatus: active\npriority: 2\n---\n# Apollo\n\nOwner:: [[Ada]]\nBudget:: 1200\n",
  "Projects/Zephyr.md": "---\ntype: Project\nstatus: paused\npriority: 1\n---\n# Zephyr\n\nSee [[Apollo]].\n",
};
const vault = new Vault(Object.entries(notes).map(([path, content]) => readPage({ path, content, ctime: DAY - 864e5, mtime: DAY })));
const run = (q: string, thisPath: string | null = null) => runQuery(q, vault, { thisPath, offset: 60, now: DAY });
const table = (q: string, thisPath: string | null = null) => {
  const r = run(q, thisPath);
  if (r.kind !== "table") throw new Error(JSON.stringify(r));
  return r;
};
const cell = (v: any): any => (v && typeof v === "object" ? (v.t === "link" ? v.display : v.t === "list" ? v.items.map(cell) : (v.text ?? v)) : v);
const rows = (q: string, thisPath: string | null = null) => table(q, thisPath).rows.map((r) => r.map(cell));

describe("queries", () => {
  test("TABLE with FROM a folder, WHERE and SORT, with headers from AS", () => {
    const r = table('TABLE status AS "State", priority\nFROM "Projects"\nWHERE type = "Project"\nSORT priority ASC');
    expect(r.idHeader).toBe("File");
    expect(r.headers).toEqual(["State", "priority"]);
    expect(r.rows.map((x) => x.map(cell))).toEqual([
      ["Zephyr", "paused", 1],
      ["Apollo", "active", 2],
    ]);
  });

  test("WITHOUT ID, LIMIT, and SORT DESC on dates", () => {
    expect(rows('TABLE WITHOUT ID file.name, date FROM "Meetings" SORT date DESC LIMIT 1')).toEqual([["Review", "July 27, 2026"]]);
  });

  test("contains on lists of links, and this.file.link; aliases resolve", () => {
    // Review lists [[Countess]], an alias of Ada.
    expect(rows('TABLE WITHOUT ID file.name FROM "" WHERE type = "Meeting" AND contains(attendees, this.file.link) SORT file.name', "People/Ada.md")).toEqual([["Kickoff"], ["Review"]]);
    expect(rows('TABLE WITHOUT ID file.name FROM "" WHERE contains(attendees, this.file.link)', "People/Brian.md")).toEqual([["Kickoff"]]);
    // A link isn't its name, as in Dataview.
    expect(table('TABLE FROM "" WHERE contains(attendees, this.file.name)', "People/Brian.md").total).toBe(0);
  });

  test("a link's fields are the linked page's; equality with this.file.link", () => {
    expect(rows('TABLE WITHOUT ID file.name, project.status FROM "Meetings" WHERE project = [[Apollo]] SORT file.name')).toEqual([
      ["Kickoff", "active"],
      ["Review", "active"],
    ]);
  });

  test("FROM #tag (with subtags), [[link]] (backlinks), outgoing(), negation and OR", () => {
    expect(rows('TABLE WITHOUT ID file.name FROM #work')).toEqual([["Review"]]);
    expect(rows('TABLE WITHOUT ID file.name FROM [[Apollo]] SORT file.name')).toEqual([["Kickoff"], ["Review"], ["Zephyr"]]);
    expect(rows('TABLE WITHOUT ID file.name FROM outgoing([[Kickoff]]) SORT file.name')).toEqual([["Ada"], ["Apollo"], ["Brian"]]);
    expect(rows('TABLE WITHOUT ID file.name FROM "Projects" OR "People" AND -"People/Brian" SORT file.name')).toEqual([["Ada"], ["Apollo"], ["Zephyr"]]);
  });

  test("GROUP BY: the key, rows.field and length(rows)", () => {
    const r = table('TABLE WITHOUT ID key AS "Type", length(rows) AS "Count", rows.file.name AS "Notes" FROM "" GROUP BY type');
    expect(r.rows.map((x) => x.map(cell))).toEqual([
      ["Meeting", 2, ["Kickoff", "Review"]],
      ["Person", 2, ["Ada", "Brian"]],
      ["Project", 2, ["Apollo", "Zephyr"]],
    ]);
    expect(table('TABLE length(rows) FROM "" GROUP BY type AS kind').idHeader).toBe("kind");
  });

  test("FLATTEN a list into one row each", () => {
    expect(rows('TABLE WITHOUT ID file.name, attendees FROM "Meetings" WHERE file.name = "Kickoff" FLATTEN attendees')).toEqual([
      ["Kickoff", "Ada"],
      ["Kickoff", "Brian"],
    ]);
  });

  test("inline fields, with canonical names", () => {
    expect(rows('TABLE WITHOUT ID owner, budget * 2 FROM "Projects/Apollo"')).toEqual([["Ada", 2400]]);
  });

  test("dates and durations: date(today), dur(), arithmetic and display", () => {
    expect(rows('TABLE WITHOUT ID file.name FROM "Meetings" WHERE date >= date(today) - dur(3 days)')).toEqual([["Review"]]);
    expect(runInline("date(2026-07-27) - date(2026-07-17)", vault, { thisPath: null, offset: 0, now: DAY })).toEqual({ kind: "value", value: { t: "dur", text: "1 week, 3 days" } });
    expect(runInline('dateformat(date("2026-07-05"), "EEEE d MMMM yyyy")', vault, { thisPath: null, offset: 0, now: DAY })).toEqual({ kind: "value", value: "Sunday 5 July 2026" });
    expect(runInline("date(sow)", vault, { thisPath: null, offset: 0, now: DAY })).toEqual({ kind: "value", value: { t: "date", text: "July 27, 2026" } });
  });

  test("file times use the time zone's offset on their own date, not today's", () => {
    // 23:30 UTC on 15 January is still the 15th in London (GMT), though summer time adds an hour.
    const t = Date.UTC(2026, 0, 15, 23, 30);
    const v = new Vault([readPage({ path: "Winter.md", content: "", ctime: t, mtime: t })]);
    const day = (o: { offset: number; tz?: string }) => (runInline("file.mday", v, { thisPath: "Winter.md", ...o }) as any).value.text;
    expect(day({ offset: 60, tz: "Europe/London" })).toBe("January 15, 2026");
    expect(day({ offset: 60 })).toBe("January 16, 2026"); // without the zone's name, a fixed offset
    expect((runInline("file.mtime", v, { thisPath: "Winter.md", offset: 60, tz: "Europe/London" }) as any).value.text).toBe("11:30 PM - January 15, 2026");
  });

  test("functions: choice (and a chain of conditions), default, join, map and filter with lambdas", () => {
    expect(rows('TABLE WITHOUT ID choice(priority = 1, "high", "normal"), choice(status = "x", 1, status = "paused", 2, 3) FROM "Projects" SORT priority')).toEqual([
      ["high", 2],
      ["normal", 3],
    ]);
    const v = (e: string) => (runInline(e, vault, { thisPath: "Projects/Apollo.md", offset: 0, now: DAY }) as any).value;
    expect(v('join(map([1, 2, 3], (x) => x * 2), "-")')).toBe("2-4-6");
    expect(v("length(filter(dv.pages(\"\"), (p) => p.type = \"Person\"))")).toBe(2);
    expect(v("default(missing, \"none\")")).toBe("none");
    expect(v('contains(["this", "is", "example"], "ex")')).toBe(true);
    expect(v('econtains(["this", "is", "example"], "ex")')).toBe(false);
    expect(v("this.file.name")).toBe("Apollo");
  });

  test("TASK: matching tasks with their subtasks, grouped by note", () => {
    const r = run('TASK FROM "Meetings" WHERE !completed');
    expect(r.kind).toBe("task");
    const t = r as Extract<Result, { kind: "task" }>;
    expect(t.groups.map((g) => cell(g.key))).toEqual(["Kickoff", "Review"]);
    // "Ask facilities" matched too, but shows under "Book room" rather than twice.
    expect(t.groups[0]!.tasks.map((x) => [x.text, x.children.map((c) => c.text)])).toEqual([["Book room #admin", ["Ask facilities"]]]);
    expect(t.groups[1]!.tasks.map((x) => x.text)).toEqual(["Write notes 📅 2026-07-28"]);
    // Task fields: tags in its text, [due:: …] and 📅.
    expect((run('TASK FROM "" WHERE contains(tags, "#admin")') as any).total).toBe(1);
    expect((run('TASK FROM "" WHERE due = date(2026-07-28)') as any).total).toBe(1);
    expect((run('TASK FROM "" WHERE completed AND due < date(today)') as any).total).toBe(1);
  });

  test("LIST: links, LIST expr, and grouped", () => {
    const l = run('LIST FROM "People"') as Extract<Result, { kind: "list" }>;
    expect(l.items.map((i) => cell(i.value))).toEqual(["Ada", "Brian"]);
    const e = run('LIST status FROM "Projects"') as Extract<Result, { kind: "list" }>;
    expect(e.items.map((i) => [cell(i.id), cell(i.value)])).toEqual([
      ["Apollo", "active"],
      ["Zephyr", "paused"],
    ]);
    const g = run('LIST FROM "" WHERE type GROUP BY type') as Extract<Result, { kind: "list" }>;
    expect(g.items.map((i) => [cell(i.value), i.children!.length])).toEqual([
      ["Meeting", 2],
      ["Person", 2],
      ["Project", 2],
    ]);
  });
});

describe("CALENDAR", () => {
  test("each note on the day of its date, in date order; notes without one left out", () => {
    const r = run('CALENDAR date FROM "Meetings"');
    expect(r).toMatchObject({ kind: "calendar", total: 2, today: "2026-07-27" });
    const c = r as Extract<Result, { kind: "calendar" }>;
    expect(c.days.map((d) => [d.day, cell(d.value)])).toEqual([
      ["2026-07-20", "Kickoff"],
      ["2026-07-27", "Review"],
    ]);
    expect((run('CALENDAR date FROM "People"') as any).days).toEqual([]);
  });

  test("the app shows a month to move through; a published page shows every month, still", () => {
    const opts = { canTick: false, inline: (md: string) => md, link: (_p: string, d: string) => `<a>${d}</a>` };
    const r = run('CALENDAR date FROM "Meetings"');
    const live = renderResult(r, opts);
    expect(live).toContain('<span class="dv-cal-title">July 2026 <span class="dv-count">2</span></span>');
    expect(live).toContain('data-dv-month="2026-06" aria-label="Previous month"');
    expect(live).toContain('data-dv-day="2026-07-20" aria-label="Monday 20 July 2026, 1 note"');
    expect(live).toContain('class="dv-cal-day dv-cal-has dv-cal-today"');
    // July 2026 starts on a Wednesday: two empty cells first, Monday-first weeks.
    expect(live).toMatch(/<tbody><tr><td class="dv-cal-out"><\/td><td class="dv-cal-out"><\/td><td class="dv-cal-day">/);
    const day = renderResult(r, { ...opts, calendar: { month: "2026-07", day: "2026-07-27" } });
    expect(day).toContain('<div class="dv-cal-date">Monday 27 July 2026</div><ul><li><a>Review</a></li></ul>');
    expect(day).not.toContain("Kickoff");
    const still = renderResult(r, { ...opts, calendar: "all" });
    expect(still).not.toContain("<button");
    expect(still).not.toContain("dv-cal-today");
    expect(renderResult(run('CALENDAR date FROM "Meetings" WHERE date < date(2026-07-01)'), opts)).toContain("Nothing in July 2026.");
  });
});

describe("inline expressions", () => {
  test("`= expr` and the dv.pages(…).where(…).length form; other JavaScript stays as code", () => {
    expect(inlineQuery("= this.status")).toBe("this.status");
    expect(inlineQuery('$= dv.pages("").where(p => p.type == "Project" && p.status != "paused").length')).not.toBeNull();
    expect(inlineQuery("$= dv.current().file.name")).toBeNull();
    expect(inlineQuery("$= document.cookie")).toBeNull();
    expect(inlineQuery("plain code")).toBeNull();
    const expr = inlineQuery('$= dv.pages("").where(p => p.type == "Project" && p.status != "paused").length')!;
    expect(runInline(expr, vault, { thisPath: null, offset: 0 })).toEqual({ kind: "value", value: 1 });
    const some = inlineQuery('$= dv.pages("").where(p => p.tags && p.tags.some(t => t.includes("work"))).length')!;
    expect(runInline(some, vault, { thisPath: null, offset: 0 })).toEqual({ kind: "value", value: 1 });
  });
});

describe("errors and limits", () => {
  test("a mistake is a message, not a crash", () => {
    expect(run("TABLE FROM WHERE")).toMatchObject({ kind: "error" });
    expect(run("SELECT * FROM notes")).toEqual({ kind: "error", message: 'a query starts with TABLE, LIST, TASK or CALENDAR, but found "SELECT" (line 1)' });
    expect(run('TABLE nosuch(1) FROM ""')).toEqual({ kind: "error", message: "there's no function called nosuch" });
    expect(run("CALENDAR")).toMatchObject({ kind: "error" });
  });

  test("patterns that could hang aren't run, and a runaway query stops", () => {
    expect(runInline('regextest("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")', vault, { thisPath: null, offset: 0 })).toEqual({ kind: "error", message: "that pattern could be slow, so it isn't run" });
    const l = `[${Array.from({ length: 100 }, (_, i) => i).join(",")}]`;
    const big = `length(map(${l}, (a) => map(${l}, (b) => map(${l}, (c) => map(${l}, (d) => a * b * c * d)))))`;
    expect(runInline(big, vault, { thisPath: null, offset: 0 })).toEqual({ kind: "error", message: "this query is too big to run" });
  });
});

describe("rendering", () => {
  const opts = { canTick: true, inline: (md: string) => md.replace(/[<>&]/g, ""), link: (p: string, d: string) => `<a data-p="${p}">${d}</a>` };
  test("a table has the count by its first heading, and values escaped", () => {
    const html = renderResult(run('TABLE status FROM "Projects" SORT file.name'), opts);
    expect(html).toContain('<th>File <span class="dv-count">2</span></th><th>status</th>');
    expect(html).toContain('<a data-p="Projects/Apollo">Apollo</a>');
    expect(renderResult({ kind: "error", message: "<b>x</b>" }, opts)).toBe('<div class="dv-error">Dataview: &lt;b&gt;x&lt;/b&gt;</div>');
  });
  test("tasks are checkboxes that say where they are", () => {
    const html = renderResult(run('TASK FROM "Meetings/Review"'), opts);
    expect(html).toContain('data-path="Meetings/Review.md" data-line="10"');
  });
});
