// How the browser resolves a [[link]] against the note list (web/lib/links.ts: resolveLocal), in
// the same order as the server. Pure functions, no database needed.

import { expect, test } from "bun:test";
import { resolveLocal } from "../web/lib/links";

const notes = [
  { id: 1, path: "People/Samuel Okafor.md", title: "Samuel Okafor", tags: [], updated_at: "", aliases: ["sam", "sam-okafor"] },
  { id: 2, path: "Sam.md", title: "Sam", tags: [], updated_at: "" },
  { id: 3, path: "Kitchen.md", title: "Kitchen", tags: [], updated_at: "", aliases: null },
];

test("links resolve by path, title, path tail, then alias or id, as on the server", () => {
  expect(resolveLocal(notes, "Sam")?.id).toBe(2); // a title wins over another note's alias
  expect(resolveLocal(notes, "sam-okafor")?.id).toBe(1);
  expect(resolveLocal(notes.slice(0, 1), "Sam")?.id).toBe(1);
  expect(resolveLocal(notes, "people/samuel okafor")?.id).toBe(1);
  expect(resolveLocal(notes, "Nobody")).toBeUndefined();
});

test("resolveLocal agrees with a plain scan: path, then title, then path end, then alias; shortest path on a tie", () => {
  const list = [
    { id: 1, path: "a/Deep/Plan.md", title: "Plan", tags: [], updated_at: "" },
    { id: 2, path: "b/Plan.md", title: "Plan", tags: [], updated_at: "" },
    { id: 3, path: "Plan.md", title: "Plan", tags: [], updated_at: "" },
    { id: 4, path: "x/Goals.md", title: "Goals", tags: [], updated_at: "", aliases: ["plan", "aims"] },
    { id: 5, path: "y/Goals.md", title: "Goals", tags: [], updated_at: "" },
    { id: 6, path: "deep/plan/notes.md", title: "notes", tags: [], updated_at: "" },
  ];
  expect(resolveLocal(list, "Plan")?.id).toBe(3); // exact path beats titles and aliases
  expect(resolveLocal(list.slice(0, 2), "Plan")?.id).toBe(2); // equal rank: shorter path
  expect(resolveLocal(list, "deep/plan")?.id).toBe(1); // path end
  expect(resolveLocal(list, "Goals")?.id).toBe(4); // equal title and length: the first
  expect(resolveLocal(list, "aims")?.id).toBe(4);
  expect(resolveLocal(list, "plan/notes")?.id).toBe(6);
  expect(resolveLocal([...list, { id: 7, path: "New.md", title: "New", tags: [], updated_at: "" }], "new")?.id).toBe(7); // a new list, a new index
});
