// dataviewjs: the loop guard put into a note's script before it runs (web/sandbox/loopGuard.ts),
// and the cleaning of what a script drew before it goes on a published page (src/publish.ts).

import { describe, expect, test } from "bun:test";
import { cleanFrozen } from "../src/publish";
import { GUARD, guardLoops } from "../web/sandbox/loopGuard";

/** Run guarded code as the sandbox does, with a guard that gives up after `limit` calls. */
async function runGuarded(code: string, limit = 10_000) {
  let calls = 0;
  const guard = () => {
    if (++calls > limit) throw new Error("stopped");
  };
  const fn = new Function(GUARD, `"use strict";\nreturn (async () => {\n${guardLoops(code)}\n})();`);
  return { value: await fn(guard), calls };
}

describe("loop guard", () => {
  test("every kind of loop is guarded, with or without braces", () => {
    const out = guardLoops("for (;;) x();\nwhile (a) { b(); }\ndo c(); while (d);\nfor (const k in o) {}\nfor (const v of xs) y(v);");
    expect(out.match(new RegExp(`${GUARD}\\(\\)`, "g"))!.length).toBe(5);
  });

  test("endless loops of each kind are stopped", async () => {
    for (const code of ["while (true) {}", "for (;;);", "do {} while (1)", "let i = 0; while (true) i++;", "outer: for (;;) { for (;;) { continue outer; } }", "while (true) await null;"]) {
      await expect(runGuarded(code)).rejects.toThrow("stopped");
    }
  });

  test("ordinary code runs as before, top-level await and return included", async () => {
    const r = await runGuarded("let s = 0;\nfor (let i = 0; i < 10; i++) s += i;\nconst xs = [1, 2, 3].map((x) => { let t = 0; while (t < x) t++; return t; });\nawait Promise.resolve();\nreturn [s, xs, `a ${'b'}`, /for(;;)/.test('x')];");
    expect(r.value).toEqual([45, [1, 2, 3], "a b", false]);
  });

  test("loops in strings, comments and regexes aren't touched; code that doesn't parse is left alone", () => {
    const src = "const s = 'while (true) {}'; // for (;;) {}\nconst r = /do {} while/;";
    expect(guardLoops(src)).toBe(src);
    expect(guardLoops("while (")).toBe("while (");
  });
});

describe("a frozen dataviewjs block on a published page", () => {
  const note = (t: string) => (t.startsWith("Public") ? `../${t}/` : null);

  test("keeps Dataview's layout and turns note links into page links, or words", () => {
    const html = `<div class="dv-table"><table><thead><tr><th scope="col">Name <span class="dv-count">2</span></th></tr></thead><tbody><tr><td colspan="2"><a class="internal-link" data-dv-open="Public/A" href="#">A</a></td></tr><tr><td><a class="internal-link" data-dv-open="Private/B" href="#">B <b>secret</b></a></td></tr></tbody></table></div>`;
    expect(cleanFrozen(html, note)).toBe(`<div class="dv-table"><table><thead><tr><th scope="col">Name <span class="dv-count">2</span></th></tr></thead><tbody><tr><td colspan="2"><a class="internal-link" href="../Public/A/">A</a></td></tr><tr><td>B <b>secret</b></td></tr></tbody></table></div>`);
  });

  test("drops script, handlers, styles, frames, forms and buttons; checkboxes are disabled", () => {
    const html = `<p onclick="x()" style="color:red" class="ok bad!x">Hi<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="/"></iframe><style>*{}</style><button data-dv-day="2026-01-01">1</button><input type="checkbox" class="dv-task" checked data-path="a.md"><input type="text" value="x"><a href="javascript:alert(1)">j</a><a href="https://example.com/" target="_top">w</a></p>`;
    expect(cleanFrozen(html, note)).toBe(`<p class="ok">Hi<input type="checkbox" class="dv-task" disabled checked>j<a href="https://example.com/" rel="noopener noreferrer nofollow">w</a></p>`);
  });

  test("text stays text", () => {
    expect(cleanFrozen("a &lt;b&gt; & c < d", note)).toBe("a &lt;b&gt; &amp; c &lt; d");
  });
});
