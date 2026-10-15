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
