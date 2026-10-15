// The client's entry point (loaded by web/index.html, bundled by Bun): fits the app to the iPhone's
// visual viewport, registers the service worker, and mounts App.

import { createRoot } from "react-dom/client";
import { App } from "./App";

// iOS Safari overlays the keyboard on the page instead of resizing it, which would hide the
// formatting bar and the cursor. Size the app to the visual viewport instead.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
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

// No StrictMode: its double-mounted effects would open and tear down each note's live socket twice.
createRoot(document.getElementById("root")!).render(<App />);
