// Scoring for the ⌘K command palette (web/components/CommandPalette.tsx: commandScore) and the
// fuzzy matcher behind it (web/lib/links.ts: fuzzyScore). Pure functions, no database needed.

import { expect, test } from "bun:test";
import { commandScore } from "../web/components/CommandPalette";
import { fuzzyScore } from "../web/lib/links";

const account = { title: "Account", group: "Settings" as const, keywords: "profile name password sign out log out" };
const heading = { title: "Heading 1", group: "Insert" as const, keywords: "h1 title" };

test("a command palette query matches word by word, in any order, and leaves out what doesn't match", () => {
  expect(commandScore("account settings", account)).toBeGreaterThan(0);
  expect(commandScore("settings account", account)).toBeGreaterThan(0);
  expect(commandScore("account settings", heading)).toBe(-Infinity); // used to score 49 and stay in the list
  expect(commandScore("zzz", heading)).toBe(-Infinity);
  expect(commandScore("api key", { title: "AI assistants", group: "Settings", keywords: "bring your own ai key model provider" })).toBeGreaterThan(-Infinity); // a weak match scores below 0

  expect(commandScore("acc", account)).toBeGreaterThan(commandScore("pass", account)); // the title counts for more
});

test("fuzzyScore: no match is -Infinity, so adding a bonus can't make it one", () => {
  expect(fuzzyScore("xyz", "Kitchen plan")).toBe(-Infinity);
  expect(fuzzyScore("xyz", "Kitchen plan") + 50).toBe(-Infinity);
  expect(fuzzyScore("kpl", "Kitchen plan")).toBeGreaterThan(-Infinity);
});
