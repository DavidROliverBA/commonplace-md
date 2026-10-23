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
});
