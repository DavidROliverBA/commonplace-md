// The standalone build's entry point (standalone/build.ts): the app's styles, then the app.

import "../web/styles.css";
import "./standalone.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const vv = window.visualViewport;
if (vv) {
  const fit = () => document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
  vv.addEventListener("resize", fit);
  fit();
}

createRoot(document.getElementById("root")!).render(<App />);
