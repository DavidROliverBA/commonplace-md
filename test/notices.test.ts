// THIRD_PARTY_NOTICES.md lists every package Commonplace ships or runs, with its licence text.
// Fails when a dependency is added, removed or updated without `bun run notices`.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { NOTICES, packages, render } from "../scripts/notices";

test("THIRD_PARTY_NOTICES.md is up to date with the installed dependencies (bun run notices)", () => {
  const list = packages();
  expect(list.length).toBeGreaterThan(50);
  for (const p of list) expect(p.licence).not.toBe("UNKNOWN");
  expect(readFileSync(NOTICES, "utf8")).toBe(render(list));
});
