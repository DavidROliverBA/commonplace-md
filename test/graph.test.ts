// The graph's scopes, filters and neighbourhoods (web/lib/graph.ts), after Capacities.

import { describe, expect, test } from "bun:test";
import { noteWhen } from "../src/graph";
import { activeFilters, addMonths, MAX_BARS, canShowMore, daySpan, type GraphData, graphUrl, NO_FILTERS, neighbourhood, outside, perMonth, rangeFrom, rangeWords, scopeFrom, shown } from "../web/lib/graph";

const node = (id: number, title: string, extra: Partial<GraphData["nodes"][number]> = {}) => ({ id, title, path: `${title}.md`, type: null, tags: [], daily: false, when: "2026-10-01", whenFrom: "made" as const, ...extra });
// Kickoff (Meeting) —attendees→ Sam (Person) —text→ Garden; Diary (daily) → Kickoff; Lonely alone.
const data: GraphData = {
  nodes: [
    node(1, "Kickoff", { type: "Meeting", path: "Work/Kickoff.md" }),
    node(2, "Sam", { type: "Person", tags: ["people"] }),
    node(3, "Garden", { tags: ["home/garden"] }),
    node(4, "2026-10-23", { daily: true, path: "Daily/2026-10-23.md" }),
    node(5, "Lonely", { path: "Work/Lonely.md" }),
  ],
  edges: [
    { source: 1, target: 2, label: "attendees" },
    { source: 2, target: 3, label: null },
    { source: 4, target: 1, label: null },
  ],
  types: [{ name: "Meeting", icon: "calendar", colour: "amber" }, { name: "Person", icon: "user", colour: "blue" }],
};
const ids = (s: ReturnType<typeof shown>) => s.nodes.map((n) => n.id).sort();

describe("the graph after Capacities", () => {
  test("around a note: direct links first, then Show more steps out", () => {
    expect([...neighbourhood(data.edges, 1, 1)].sort()).toEqual([1, 2, 4]);
    expect([...neighbourhood(data.edges, 1, 2)].sort()).toEqual([1, 2, 3, 4]);
    expect(canShowMore(data.edges, 1, 1)).toBe(true);
    expect(canShowMore(data.edges, 1, 2)).toBe(false);
    expect(ids(shown(data, { centre: 1, depth: 1, filters: NO_FILTERS }))).toEqual([1, 2, 4]);
  });

  test("scopes: a type, a folder, a tag (and its sub-tags), a search's notes", () => {
    expect(ids(shown(data, { scope: { kind: "type", value: "person" }, filters: NO_FILTERS }))).toEqual([2]);
    expect(ids(shown(data, { scope: { kind: "folder", value: "Work" }, filters: NO_FILTERS }))).toEqual([1, 5]);
    expect(ids(shown(data, { scope: { kind: "tag", value: "#home" }, filters: NO_FILTERS }))).toEqual([3]);
    expect(ids(shown(data, { scope: { kind: "search", value: "x", ids: [2, 3] }, filters: NO_FILTERS }))).toEqual([2, 3]);
  });

  test("filters: only or hide types, daily notes, unlinked notes; the centre always stays", () => {
    expect(ids(shown(data, { filters: { ...NO_FILTERS, only: ["Person", ""] } }))).toEqual([2, 3, 4, 5]);
    expect(ids(shown(data, { filters: { ...NO_FILTERS, hide: ["meeting"] } }))).toEqual([2, 3, 4, 5]);
    expect(ids(shown(data, { filters: { ...NO_FILTERS, daily: false, orphans: false } }))).toEqual([1, 2, 3]);
    expect(ids(shown(data, { centre: 1, depth: 1, filters: { ...NO_FILTERS, hide: ["Meeting"] } }))).toEqual([1, 2, 4]);
    const s = shown(data, { filters: { ...NO_FILTERS, only: ["Book"] } });
    expect(s.nodes).toEqual([]);
    expect(s.before).toBe(5); // filtered out, not an empty vault
    expect(activeFilters({ ...NO_FILTERS, hide: ["x"], busy: true })).toBe(2);
  });

  test("labels stay on their links, and degrees count the whole vault", () => {
    const s = shown(data, { scope: { kind: "type", value: "Meeting" }, filters: NO_FILTERS });
    expect(s.nodes[0]!.deg).toBe(2);
    expect(shown(data, { filters: NO_FILTERS }).edges.find((e) => e.target === 2)!.label).toBe("attendees");
  });

  test("the page's address round-trips a scope and a centre", () => {
    expect(graphUrl(7, { type: "Person" })).toBe("/v/7/graph?type=Person");
    expect(graphUrl(7)).toBe("/v/7/graph");
    expect(scopeFrom("?folder=Work%2FLater&note=4")).toEqual({ scope: { kind: "folder", value: "Work/Later" }, note: 4 });
    expect(scopeFrom("?search=boiler")).toEqual({ scope: { kind: "search", value: "boiler", ids: [] }, note: null });
  });
});

describe("the timeline (F21)", () => {
  const made = "2026-10-20";
  test("a note's date: the daily note's day, then date properties, then the type's, then when it was made", () => {
    expect(noteWhen({ path: "Daily/2025-03-04.md", frontmatter: { date: "2020-01-01" }, made }, null)).toEqual({ when: "2025-03-04", whenFrom: "daily" });
    expect(noteWhen({ path: "Kickoff.md", frontmatter: { Date: "2025-05-06T09:30" }, made }, null)).toEqual({ when: "2025-05-06", whenFrom: "property" });
    // Impossible days and placeholders don't count: the note falls back to when it was made.
    for (const date of ["2025-13-01", "2025-02-30", "0001-01-01"]) expect(noteWhen({ path: "Odd.md", frontmatter: { date }, made }, null).whenFrom).toBe("made");
    expect(noteWhen({ path: "Old.md", frontmatter: { created: "2019-12-31" }, made }, null)).toEqual({ when: "2019-12-31", whenFrom: "property" });
    expect(noteWhen({ path: "Dune.md", frontmatter: { finished: "2024-08-01" }, made }, "finished")).toEqual({ when: "2024-08-01", whenFrom: "property" });
    // A value that isn't a day, or a property the type doesn't place notes by, falls through.
    expect(noteWhen({ path: "Sam.md", frontmatter: { date: "soon", birthday: "1980-02-03" }, made }, null)).toEqual({ when: made, whenFrom: "made" });
  });

  test("the span, notes per month (gaps included) and the notes outside a range", () => {
    const ns = [
      { id: 1, when: "2025-01-15" },
      { id: 2, when: "2025-01-20" },
      { id: 3, when: "2025-04-02" },
    ];
    const span = daySpan(ns)!;
    expect(span).toEqual({ from: "2025-01-15", to: "2025-04-02" });
    expect(perMonth(ns, span)).toEqual([
      { month: "2025-01", months: 1, count: 2 },
      { month: "2025-02", months: 1, count: 0 },
      { month: "2025-03", months: 1, count: 0 },
      { month: "2025-04", months: 1, count: 1 },
    ]);
    // A long span groups months, never more than MAX_BARS bars: a thousand years is 200 bars of five years.
    const far = [{ when: "1025-06-01" }, { when: "2025-06-01" }, { when: "2025-07-01" }];
    const bars = perMonth(far, daySpan(far)!);
    expect(bars.length).toBeLessThanOrEqual(MAX_BARS);
    expect(bars.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(bars[0]).toMatchObject({ month: "1025-06", count: 1 });
    expect(bars[0]!.months % 12).toBe(0);
    expect([...outside(ns, { from: "2025-01-16", to: "2025-03-31" })].sort()).toEqual([1, 3]);
    expect(outside(ns, null).size).toBe(0);
    expect(daySpan([])).toBeNull();
  });

  test("months step within each month's length; ranges read as words and come from the address", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2025-03-15", -3)).toBe("2024-12-15");
    expect(rangeWords({ from: "2025-03-01", to: "2025-06-30" })).toBe("March to June 2025");
    expect(rangeWords({ from: "2024-11-01", to: "2025-02-28" })).toBe("November 2024 to February 2025");
    expect(rangeWords({ from: "2025-03-01", to: "2025-03-31" })).toBe("March 2025");
    expect(rangeWords({ from: "2025-03-04", to: "2025-03-04" })).toBe("4 March 2025");
    expect(rangeWords({ from: "2025-03-04", to: "2025-05-10" })).toBe("4 March to 10 May 2025");
    expect(rangeFrom("?type=Meeting&from=2025-03-01&to=2025-06-30")).toEqual({ from: "2025-03-01", to: "2025-06-30" });
    expect(rangeFrom("?from=2025-06-30&to=2025-03-01")).toBeNull();
    expect(rangeFrom("?from=March")).toBeNull();
  });
});
