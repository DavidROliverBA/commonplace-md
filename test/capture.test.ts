// How a share becomes inbox lines (src/capture.ts), for the shapes the iPhone Shortcut sends; and
// src/weblinks.ts reading a page's title and refusing private addresses. No database needed.

import { describe, expect, test } from "bun:test";
import { appendEntries, entryFor, linkFor, plan } from "../src/capture";

const shared = (o: Partial<Parameters<typeof plan>[0]>) => ({ files: [], texts: [], urls: [], title: "", ...o });

describe("capture", () => {
  test("a bare link becomes a titled link; without a title, its address names it", () => {
    expect(plan(shared({ texts: ["https://example.com/a"], urls: ["https://example.com/a"], title: "A guide" })).lines).toEqual(["[A guide](https://example.com/a)"]);
    expect(linkFor("https://www.bbc.co.uk/news/", "")).toBe("[bbc.co.uk/news](https://www.bbc.co.uk/news/)");
    expect(linkFor("https://x.org/a (b)", "[odd] title")).toBe("[odd title](https://x.org/a%20%28b%29)");
  });

  test("a web page's whole text, sent alongside its link, is replaced by the link", () => {
    const page = "Lorem ipsum ".repeat(200);
    expect(plan(shared({ texts: [page], urls: ["https://example.com/p"] })).lines).toEqual(["[example.com/p](https://example.com/p)"]);
  });

  test("a note with a link in it is kept as written, not doubled", () => {
    const t = "Look at https://example.com/x before Friday";
    expect(plan(shared({ texts: [t], urls: ["https://example.com/x"] })).lines).toEqual([t]);
  });

  test("photos win over the text field, which is only the photo's name", () => {
    const photo = new File([new Uint8Array(4)], "IMG_1.HEIC");
    const p = plan(shared({ files: [photo], texts: ["IMG_1"] }));
    expect(p.files).toEqual([photo]);
    expect(p.lines).toEqual([]);
  });

  test("entries are to-dos with the time; extra lines are indented into the item", () => {
    expect(entryFor("Call Sam\nabout tiles\n\nsoon", "11 Oct 09:15")).toBe("- [ ] Call Sam · 11 Oct 09:15\n  about tiles\n\n  soon");
  });

  test("appending keeps the list together and the intro apart", () => {
    expect(appendEntries("# Inbox\n\nIntro.\n", ["- [ ] a"])).toBe("# Inbox\n\nIntro.\n\n- [ ] a\n");
    expect(appendEntries("# Inbox\n\n- [ ] a\n\n\n", ["- [ ] b"])).toBe("# Inbox\n\n- [ ] a\n- [ ] b\n");
    expect(appendEntries("- [ ] a\n  more", ["- [ ] b"])).toBe("- [ ] a\n  more\n- [ ] b\n");
    expect(appendEntries("", ["- [ ] a"])).toBe("- [ ] a\n");
  });
});

describe("weblinks: reading pages, and never fetching private addresses", () => {
  const { parseMeta, decodeEntities } = require("../src/weblinks");
  const { isPrivateAddress } = require("../src/addresses");
  test("Open Graph first, then the page's own title and description; relative pictures made absolute", () => {
    const html = `<head><title>Plain &amp; simple</title><meta name="description" content='Just the page'><meta property="og:image" content="img/c.jpg"></head>`;
    expect(parseMeta(html, "https://www.example.org/a/b")).toEqual({ title: "Plain & simple", description: "Just the page", site: "example.org", image: "https://www.example.org/a/img/c.jpg", url: "https://www.example.org/a/b" });
    const og = `<meta content="OG title" property="og:title"><meta property="og:site_name" content="Site"><meta property="og:image" content="javascript:alert(1)">`;
    expect(parseMeta(og, "https://x.com/")).toMatchObject({ title: "OG title", site: "Site", image: null });
    expect(decodeEntities("&#x2019;&#8216;&pound;5 &hellip;")).toBe("’‘£5 …");
  });
  test("loopback, private, link-local (cloud metadata), CGNAT and unique-local addresses are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "nonsense",
      // IPv6 spellings of private IPv4 addresses, as new URL() writes them
      "::ffff:7f00:1", "[::ffff:a9fe:a9fe]", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "0:0:0:0:0:ffff:7f00:1",
      "198.18.0.1", "192.0.0.8", "240.0.0.1", "ff02::1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.0.81", "172.32.0.1", "2a00:1450:4009::200e", "::ffff:808:808", "2002:808:808::"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});
