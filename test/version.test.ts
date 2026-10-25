// package.json's version is the newest release in docs/CHANGELOG.md, so the MCP server and the
// standalone file report the version that's actually out. Bump it with each release.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

test("package.json's version is the newest release in the changelog", () => {
  const log = readFileSync(join(root, "docs/CHANGELOG.md"), "utf8");
  const releases = [...log.matchAll(/release v(\d+)\.(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  const newest = releases.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0]!.join(".");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(newest);
});
