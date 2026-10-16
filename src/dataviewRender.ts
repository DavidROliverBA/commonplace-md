// Dataview results (src/dataview.ts) as HTML, the way the plugin lays them out: a table with
// the count beside the first heading, a list, or tasks grouped by note. Shared by the app and
// published pages, which pass their own ways of showing a link and a line of Markdown.

import type { Out, Result, TaskOut, ListOut } from "./dataview";

export interface RenderOpts {
  /** A link to a note: path (no .md), what to show, whether that note exists. */
  link(path: string, display: string, resolved: boolean, subpath: string | null): string;
  /** A string value, which Dataview shows as Markdown. Must return safe HTML. */
  inline(md: string): string;
  /** Tasks get checkboxes when the reader can tick them. */
  canTick: boolean;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderValue(v: Out, o: RenderOpts): string {
  if (v === null || v === undefined) return `<span class="dv-null">-</span>`;
  if (typeof v === "string") return o.inline(v);
  if (typeof v === "number" || typeof v === "boolean") return esc(String(v));
  switch (v.t) {
    case "link":
      return o.link(v.path, v.display, v.resolved, v.subpath);
    case "elink":
      return /^https?:\/\//i.test(v.url) ? `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.display)}</a>` : esc(v.display);
    case "date":
    case "dur":
      return esc(v.text);
    case "list":
      if (!v.items.length) return "";
      if (v.items.length === 1) return renderValue(v.items[0]!, o);
      return `<ul class="dv-list">${v.items.map((x) => `<li>${renderValue(x, o)}</li>`).join("")}</ul>`;
    case "obj":
      return `<ul class="dv-list">${v.entries.map(([k, x]) => `<li><strong>${esc(k)}</strong>: ${renderValue(x, o)}</li>`).join("")}</ul>`;
  }
}

function more(shown: number, total: number) {
  return total > shown ? `<p class="dv-more">Showing ${shown.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")}.</p>` : "";
}

function listItems(items: ListOut[], o: RenderOpts): string {
  return `<ul class="dv-result-list">${items
    .map((it) => {
      const head = it.id !== undefined ? `${renderValue(it.id, o)}: ${renderValue(it.value, o)}` : renderValue(it.value, o);
      return `<li>${head}${it.children?.length ? listItems(it.children, o) : ""}</li>`;
    })
    .join("")}</ul>`;
}

function tasks(ts: TaskOut[], o: RenderOpts): string {
  return `<ul class="dv-tasks">${ts
    .map((t) => {
      const box =
        t.status === null
          ? ""
          : `<input type="checkbox" class="dv-task"${t.status !== " " ? " checked" : ""}${o.canTick ? "" : " disabled"} data-path="${esc(t.path)}" data-line="${t.line}" data-text="${esc(t.text)}" aria-label="Done"> `;
      return `<li class="${t.status === null ? "" : "dv-task-item"}">${box}<span>${o.inline(t.text)}</span>${t.children.length ? tasks(t.children, o) : ""}</li>`;
    })
    .join("")}</ul>`;
}

export function renderResult(r: Result, o: RenderOpts, inline = false): string {
  switch (r.kind) {
    case "error":
      return inline ? `<span class="dv-error">Dataview: ${esc(r.message)}</span>` : `<div class="dv-error">Dataview: ${esc(r.message)}</div>`;
    case "value":
      return renderValue(r.value, o);
    case "table": {
      const count = `<span class="dv-count">${r.total}</span>`;
      const heads = [...(r.idHeader !== null ? [`${esc(r.idHeader)} ${count}`] : []), ...r.headers.map(esc)];
      if (r.idHeader === null && heads.length) heads[0] += ` ${count}`;
      const body = r.rows.map((row) => `<tr>${row.map((c) => `<td>${renderValue(c, o)}</td>`).join("")}</tr>`).join("");
      if (!r.rows.length) return `<p class="dv-empty">No results.</p>`;
      return `<div class="dv-table"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>${more(r.rows.length, r.total)}`;
    }
    case "list":
      if (!r.items.length) return `<p class="dv-empty">No results.</p>`;
      return listItems(r.items, o) + more(r.items.length, r.total);
    case "task": {
      if (!r.groups.length) return `<p class="dv-empty">No tasks.</p>`;
      return (
        r.groups
          .map((g) => `<div class="dv-task-group"><div class="dv-group-head">${renderValue(g.key, o)} <span class="dv-count">${g.tasks.length}</span></div>${tasks(g.tasks, o)}</div>`)
          .join("") + more(r.shown, r.total)
      );
    }
  }
}
