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
  /** A CALENDAR shows one month with buttons to move (the app), or every month it has, still
   *  (a published page, which runs no script). */
  calendar?: CalendarState | "all";
}

export interface CalendarState {
  /** "2026-07" */
  month: string;
  /** "2026-07-27", or null for the whole month's notes. */
  day: string | null;
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

// ── CALENDAR ──────────────────────────────────────────────────────────────────────────────

type Calendar = Extract<Result, { kind: "calendar" }>;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const longDay = (day: string) => {
  const d = new Date(day + "T00:00:00Z");
  return `${DAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

/** Where a calendar opens: this month if it has notes, otherwise the month of the nearest one. */
export function calendarStart(r: Calendar): CalendarState {
  const now = r.today.slice(0, 7);
  if (!r.days.length || r.days.some((d) => d.day.startsWith(now))) return { month: now, day: null };
  const t = Date.parse(r.today);
  const near = r.days.reduce((a, b) => (Math.abs(Date.parse(b.day) - t) < Math.abs(Date.parse(a.day) - t) ? b : a));
  return { month: near.day.slice(0, 7), day: null };
}

function monthGrid(r: Calendar, o: RenderOpts, month: string, selected: string | null, live: boolean): string {
  const byDay = new Map<string, Out[]>();
  for (const d of r.days) if (d.day.startsWith(month)) byDay.set(d.day, [...(byDay.get(d.day) ?? []), d.value]);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: string[] = [];
  for (let i = 0; i < first; i++) cells.push(`<td class="dv-cal-out"></td>`);
  for (let n = 1; n <= days; n++) {
    const day = `${month}-${String(n).padStart(2, "0")}`;
    const notes = byDay.get(day) ?? [];
    const cls = ["dv-cal-day", notes.length ? "dv-cal-has" : "", day === r.today && live ? "dv-cal-today" : "", day === selected ? "dv-cal-selected" : ""].filter(Boolean).join(" ");
    const dots = notes.length ? `<span class="dv-cal-dots" aria-hidden="true">${"<i></i>".repeat(Math.min(notes.length, 3))}${notes.length > 3 ? "+" : ""}</span>` : "";
    const label = `${longDay(day)}${notes.length ? `, ${notes.length} ${notes.length === 1 ? "note" : "notes"}` : ""}`;
    const inner = `<span class="dv-cal-n">${n}</span>${dots}`;
    cells.push(`<td class="${cls}">${live && notes.length ? `<button type="button" data-dv-day="${day}" aria-label="${esc(label)}"${day === selected ? ' aria-pressed="true"' : ""}>${inner}</button>` : `<span aria-label="${esc(label)}">${inner}</span>`}</td>`);
  }
  while (cells.length % 7) cells.push(`<td class="dv-cal-out"></td>`);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(`<tr>${cells.slice(i, i + 7).join("")}</tr>`);
  const count = [...byDay.values()].reduce((a, v) => a + v.length, 0);
  const head = live
    ? `<div class="dv-cal-head"><button type="button" class="dv-cal-nav" data-dv-month="${shiftMonth(month, -1)}" aria-label="Previous month">‹</button><span class="dv-cal-title">${monthName(month)} <span class="dv-count">${count}</span></span><button type="button" class="dv-cal-nav" data-dv-month="${shiftMonth(month, 1)}" aria-label="Next month">›</button>${month !== r.today.slice(0, 7) ? `<button type="button" class="dv-cal-nav dv-cal-now" data-dv-month="${r.today.slice(0, 7)}">Today</button>` : ""}</div>`
    : `<div class="dv-cal-head"><span class="dv-cal-title">${monthName(month)} <span class="dv-count">${count}</span></span></div>`;
  const grid = `<table class="dv-cal-grid"><thead><tr>${DAYS.map((d) => `<th scope="col" abbr="${d}">${d.slice(0, 3)}</th>`).join("")}</tr></thead><tbody>${weeks.join("")}</tbody></table>`;
  // Below the month: the chosen day's notes, or every day's that has some.
  const shown = [...byDay].filter(([day]) => !selected || day === selected);
  const list = shown.length
    ? `<div class="dv-cal-list">${shown.map(([day, ns]) => `<div class="dv-cal-date">${esc(longDay(day))}</div><ul>${ns.map((v) => `<li>${renderValue(v, o)}</li>`).join("")}</ul>`).join("")}</div>`
    : `<p class="dv-empty">Nothing in ${monthName(month)}.</p>`;
  return `<div class="dv-calendar">${head}${grid}${list}</div>`;
}

function renderCalendar(r: Calendar, o: RenderOpts): string {
  if (o.calendar === "all") {
    if (!r.days.length) return `<p class="dv-empty">No results.</p>`;
    // Newest first, up to a year's worth of months that have notes.
    const months = [...new Set(r.days.map((d) => d.day.slice(0, 7)))].reverse().slice(0, 12);
    return months.map((m) => monthGrid(r, o, m, null, false)).join("");
  }
  const s = o.calendar ?? calendarStart(r);
  return monthGrid(r, o, s.month, s.day, true);
}

export function renderResult(r: Result, o: RenderOpts, inline = false): string {
  switch (r.kind) {
    case "calendar":
      return renderCalendar(r, o);
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
