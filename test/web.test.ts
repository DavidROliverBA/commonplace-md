// The assistant's page reader (src/web.ts): a page's readable text, without scripts and menus.

import { describe, expect, test } from "bun:test";
import { pageText } from "../src/web";

describe("reading a web page for the assistant", () => {
  test("the article's text, with headings, lists and table rows on their own lines", () => {
    const html = `<!doctype html><html><head><title>Boiler servicing &amp; you</title><style>p{}</style></head><body>
      <nav><a href="/">Home</a> <a href="/shop">Shop</a></nav>
      <article><h1>Servicing</h1><p>Have it serviced <b>every 12 months</b>.</p>
      <ul><li>Check pressure</li><li>Bleed radiators</li></ul>
      <table><tr><th>Part</th><th>Cost</th></tr><tr><td>Filter</td><td>&pound;20</td></tr></table>
      <script>steal()</script></article><footer>© Someone</footer></body></html>`;
    const { title, text } = pageText(html);
    expect(title).toBe("Boiler servicing & you");
    expect(text).toContain("# Servicing");
    expect(text).toContain("Have it serviced every 12 months.");
    expect(text).toContain("- Check pressure\n- Bleed radiators");
    expect(text).toContain("Filter | £20 |");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("Shop");
    expect(text).not.toContain("Someone");
  });

  test("a page without an article keeps its body, less the furniture", () => {
    const { text } = pageText("<html><body><header><nav>Menu</nav></header><p>One</p><p>Two</p></body></html>");
    expect(text).toBe("One\nTwo");
  });

  test("a hostile page full of unclosed tags is read in linear time, not quadratic", () => {
    // 1.5 MB, the most readPage takes: openings that never close, each of which used to make a
    // regex scan to the end of the page, blocking the one server for minutes.
    for (const bit of ["<svg ", "<form ", "<!-- ", "<article ", "<h1 ", "<title ", "< "]) {
      const html = `<p>Start</p>${bit.repeat(Math.floor(1_500_000 / bit.length))}`;
      const t = performance.now();
      const { text } = pageText(html);
      expect(performance.now() - t).toBeLessThan(1500);
      expect(text.startsWith("Start") || text === "").toBe(true);
    }
  });

  test("an element that never closes takes the rest of the page; comments go", () => {
    expect(pageText("<p>Keep</p><!-- hidden --><p>Also</p><script>never ends").text).toBe("Keep\nAlso");
    expect(pageText("<main><p>Main part</p></main><p>Outside</p>").text).toBe("Main part");
  });
});
