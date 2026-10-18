// The client's entry point (loaded by web/index.html, bundled by Bun): fits the app to the iPhone's
// visual viewport, registers the service worker, and mounts App.

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isOff, offList, trace } from "./lib/debugOff";

// iOS Safari overlays the keyboard on the page instead of resizing it, which would hide the
// formatting bar and the cursor. Size the app to the visual viewport instead. Writing the height
// relays out the whole app, and iOS stops repeating a held key (delete) when that happens between
// repeats, so it's written only when it changes, and not while keys are going down: then it waits
// until typing pauses: longer than iOS's wait before a held key starts repeating (about half a
// second), since the first press can itself change the height (the suggestions bar). The keyboard
// opening or closing has no keys in it, so that's immediate.
const vv = window.visualViewport;
if (vv && !isOff("vv")) {
  let height = "";
  let lastKey = 0;
  let later: ReturnType<typeof setTimeout> | undefined;
  const PAUSE_MS = 1000;
  const setHeight = () => {
    const h = `${Math.round(vv.height)}px`;
    if (h === height || isOff("vvh")) return;
    trace(`write --vvh ${h}`);
    height = h;
    document.documentElement.style.setProperty("--vvh", h);
  };
  const fit = (e?: Event) => {
    clearTimeout(later);
    const since = performance.now() - lastKey;
    if (e) trace(`vv ${e.type} h=${Math.round(vv.height)} top=${Math.round(vv.offsetTop)}${since < PAUSE_MS ? " (wait)" : ""}`);
    if (since < PAUSE_MS) later = setTimeout(() => fit(), PAUSE_MS - since);
    else setHeight();
    if (vv.offsetTop && !isOff("vvscroll")) {
      trace("scrollTo 0");
      window.scrollTo(0, 0);
    }
  };
  window.addEventListener("keydown", () => (lastKey = performance.now()), { capture: true, passive: true });
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

// Offline (F4): a service worker keeps the app and what it needs to open, so the home-screen app
// starts with no signal. Not over plain http on another machine, where browsers don't allow it.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// A page brought back from the back/forward cache let go of its live streams when it was hidden
// (App.tsx), so start it afresh rather than show something that no longer updates.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

// Temporary (web/lib/debugOff.ts): show in the tab title which parts are off.
if (offList().length) {
  const tag = `[off: ${offList().join(",")}] `;
  new MutationObserver(() => {
    if (!document.title.startsWith(tag)) document.title = tag + document.title;
  }).observe(document.querySelector("title") ?? document.head, { childList: true, subtree: true, characterData: true });
  document.title = tag + document.title;
}

// No StrictMode: its double-mounted effects would open and tear down each note's live socket twice.
createRoot(document.getElementById("root")!).render(<App />);
