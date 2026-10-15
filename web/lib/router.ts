// A tiny client-side router: the URL is the only navigation state. navigate() pushes or replaces
// history and fires `cp:navigate`, which usePath() listens for alongside popstate; parseRoute()
// turns a path into the screen App shows. The server serves index.html for every one of these.

import { useEffect, useState } from "react";

export function navigate(path: string, replace = false) {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event("cp:navigate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    window.addEventListener("cp:navigate", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("cp:navigate", on);
    };
  }, []);
  return path;
}

export type Route =
  | { page: "home" }
  | { page: "vault"; vaultId: number }
  | { page: "note"; vaultId: number; noteId: number }
  | { page: "graph"; vaultId: number }
  | { page: "type"; vaultId: number; name: string }
  | { page: "tasks"; vaultId: number }
  | { page: "changes"; vaultId: number };

export function parseRoute(path: string): Route {
  let m = /^\/v\/(\d+)\/n\/(\d+)/.exec(path);
  if (m) return { page: "note", vaultId: Number(m[1]), noteId: Number(m[2]) };
  m = /^\/v\/(\d+)\/t\/([^/]+)/.exec(path);
  if (m) return { page: "type", vaultId: Number(m[1]), name: decodeURIComponent(m[2]!) };
  m = /^\/v\/(\d+)\/tasks/.exec(path);
  if (m) return { page: "tasks", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)\/changes/.exec(path);
  if (m) return { page: "changes", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)\/graph/.exec(path);
  if (m) return { page: "graph", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)/.exec(path);
  if (m) return { page: "vault", vaultId: Number(m[1]) };
  return { page: "home" };
}

export const noteUrl = (vaultId: number, noteId: number) => `/v/${vaultId}/n/${noteId}`;
