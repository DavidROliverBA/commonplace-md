// A type's page (F16, after Capacities' object dashboards): every note of the type as a table,
// cards or a list, with filter, sort and group by any property, quick sections (recent,
// untagged, orphans), cells that set the property when edited, and views saved as a Bases
// (`.base`) file beside the type.

import { useEffect, useMemo, useState } from "react";
import { linkTargets, type TypeProp } from "../../src/types";
import { api, type NoteSummary, type Vault } from "../lib/api";
import { fromBase, type Section, toBase, type View, type ViewKind } from "../lib/bases";
import { graphUrl } from "../lib/graph";
import { navigate, noteUrl } from "../lib/router";
import { relativeTime, resolveLocal } from "../lib/links";
import { createType, createTypedNote, setProperties, typeNamed, useTypes } from "../lib/types";
import { Icon } from "../ui/Icon";
import { PanelToggle } from "../ui/PanelToggle";
import { useNarrow } from "../lib/useNarrow";
import { chooseDialog, promptDialog, toast, toastError } from "../ui/overlays";

interface Row {
  id: number;
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  backlinks: number;
}

interface Props {
  vault: Vault;
  name: string;
  notes: NoteSummary[];
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  onNavigate: () => void;
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "all", label: "All" },
  { id: "recent", label: "Recent" },
  { id: "untagged", label: "Untagged" },
  { id: "orphans", label: "No backlinks" },
];

/** The unsaved view: every property as a table, or a list on a phone, where a wide table scrolls. */
const blankView = (columns: string[], narrow: boolean): View => ({ name: "All", kind: narrow ? "list" : "table", columns, sort: null, group: null, where: [] });

const text = (v: unknown): string => (v === null || v === undefined ? "" : Array.isArray(v) ? v.map(text).join(", ") : String(v).replace(/^\[\[|\]\]$/g, ""));

export function TypePage(p: Props) {
  useTypes();
  const narrow = useNarrow();
  const type = typeNamed(p.name);
  const canWrite = p.vault.role !== "viewer";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<View[]>([]);
  const [viewIndex, setViewIndex] = useState(-1); // -1: the unsaved "All" view
  const [view, setView] = useState<View>(blankView([], narrow));
  const [section, setSection] = useState<Section>("all");
  const [q, setQ] = useState("");

  // Columns: the type's properties, or for a type not defined yet, every property its notes use.
  const props: TypeProp[] = useMemo(() => {
    if (type) return type.properties;
    const keys = new Set<string>();
    for (const r of rows ?? []) for (const k of Object.keys(r.frontmatter)) if (k !== "type") keys.add(k);
    return [...keys].map((name) => ({ name, kind: "text" as const }));
  }, [type, rows]);

  const load = () =>
    api<{ notes: Row[]; views: string | null }>(`/vaults/${p.vault.id}/types/${encodeURIComponent(p.name)}`).then((r) => {
      setRows(r.notes);
      setSaved(fromBase(r.views));
    }, toastError);
  // Reload when notes change anywhere in the vault (the app refetches its note list on every event).
  useEffect(() => void load(), [p.vault.id, p.name, p.notes]);
  useEffect(() => {
    setViewIndex(-1);
    setSection("all");
    setQ("");
  }, [p.name]);
  useEffect(() => {
    if (viewIndex === -1) setView(blankView(props.map((x) => x.name), narrow));
  }, [props.map((x) => x.name).join("\0"), viewIndex]);

  const shown = useMemo(() => {
    let list = [...(rows ?? [])];
    if (section === "recent") list = list.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20);
    if (section === "untagged") list = list.filter((r) => !r.tags.length);
    if (section === "orphans") list = list.filter((r) => r.backlinks === 0);
    for (const w of view.where) list = list.filter((r) => text(r.frontmatter[w.prop]).toLowerCase() === w.value.toLowerCase());
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((r) => r.title.toLowerCase().includes(needle) || Object.values(r.frontmatter).some((v) => text(v).toLowerCase().includes(needle)));
    if (view.sort) {
      const { prop, dir } = view.sort;
      const val = (r: Row) => (prop === "title" ? r.title : text(r.frontmatter[prop]));
      list.sort((a, b) => val(a).localeCompare(val(b), undefined, { numeric: true }) * (dir === "asc" ? 1 : -1));
    }
    return list;
  }, [rows, section, view, q]);

  const groups = useMemo(() => {
    if (!view.group) return [{ key: "", rows: shown }];
    const m = new Map<string, Row[]>();
    for (const r of shown) {
      const k = text(r.frontmatter[view.group]) || "—";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m].sort(([a], [b]) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b))).map(([key, rows]) => ({ key, rows }));
  }, [shown, view.group]);

  const open = (id: number) => {
    navigate(noteUrl(p.vault.id, id));
    p.onNavigate();
  };

  async function set(r: Row, prop: string, value: unknown) {
    setRows((rs) => rs?.map((x) => (x.id === r.id ? { ...x, frontmatter: { ...x.frontmatter, [prop]: value } } : x)) ?? null); // at once
    try {
      await setProperties(p.vault.id, r.id, { [prop]: value === "" ? null : value });
    } catch (e) {
      toastError(e);
      void load();
    }
  }

  async function newOne() {
    if (!type) return;
    const title = await promptDialog({ title: `New ${type.name}`, label: "Title", value: "", action: "Create" });
    if (!title) return;
    try {
      const n = await createTypedNote(p.vault.id, type, title);
      open(n.id);
    } catch (e) {
      toastError(e);
    }
  }

  async function saveView() {
    const name = await promptDialog({ title: "Save this view", label: "Name", value: viewIndex >= 0 ? saved[viewIndex]!.name : "", action: "Save" });
    if (!name) return;
    const next = [...saved];
    const v = { ...view, name };
    const at = next.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) next[at] = v;
    else next.push(v);
    try {
      await api(`/vaults/${p.vault.id}/types/${encodeURIComponent(p.name)}/views`, { method: "PUT", body: { yaml: toBase(p.name, next) } });
      setSaved(next);
      setViewIndex(at >= 0 ? at : next.length - 1);
      toast(`Saved the view “${name}”. It's saved as Types/${p.name}.base, so other Markdown editors can open it too.`);
    } catch (e) {
      toastError(e);
    }
  }

  const sortBy = (prop: string) =>
    setView((v) => ({ ...v, sort: v.sort?.prop === prop ? (v.sort.dir === "asc" ? { prop, dir: "desc" } : null) : { prop, dir: "asc" } }));
  const columns = view.columns.map((c) => props.find((x) => x.name === c) ?? { name: c, kind: "text" as const });
  const groupable = props.filter((x) => x.kind !== "list" || x.name === "tags");

  return (
    <div className="type-page">
      <header className="note-header">
        <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
        <h1 className={`note-title type-title colour-${type?.colour ?? "grey"}`}>
          <Icon name={type?.icon ?? "shapes"} /> {p.name} <span className="count">{rows?.length ?? ""}</span>
        </h1>
        <div className="note-actions">
          <button className={narrow ? "icon-btn" : "quiet"} onClick={() => navigate(graphUrl(p.vault.id, { type: p.name }))} title={`The graph of every ${p.name}`} aria-label={`Graph of ${p.name}`}>
            <Icon name="graph" size={16} /> {!narrow && "Graph"}
          </button>
          {type && (
            <button className={narrow ? "icon-btn" : "quiet"} onClick={() => open(type.noteId)} title="Edit the type: its properties, icon, colour and template" aria-label="Edit the type">
              <Icon name="settings" size={16} /> {!narrow && "Edit type"}
            </button>
          )}
          {type && canWrite && (
            <button className="primary" onClick={() => void newOne()} aria-label={`New ${type.name}`}>
              <Icon name="plus" size={16} /> {narrow ? "New" : `New ${type.name}`}
            </button>
          )}
          <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
        </div>
      </header>

      <div className="type-body">
        {!type && (
          <p className="notice">
            {rows?.length ?? 0} notes say they're a {p.name}, but there's no {p.name} type yet.{" "}
            {canWrite && (
              <button
                className="link"
                onClick={() =>
                  void createType(p.vault.id, p.name)
                    .then((n) => (toast(`Made the ${p.name} type. Add its properties here.`), open(n.id)))
                    .catch(toastError)
                }
              >
                Define it
              </button>
            )}
          </p>
        )}

        <div className="type-toolbar">
          <div className="tabs type-views" role="tablist" aria-label="Views">
            <button role="tab" aria-selected={viewIndex === -1} className={viewIndex === -1 ? "on" : ""} onClick={() => setViewIndex(-1)}>
              All
            </button>
            {saved.map((v, i) => (
              <button
                key={v.name}
                role="tab"
                aria-selected={viewIndex === i}
                className={viewIndex === i ? "on" : ""}
                onClick={() => {
                  setViewIndex(i);
                  setView(v);
                }}
              >
                {v.name}
              </button>
            ))}
          </div>
          <div className="row wrap">
            <div className="segmented" role="radiogroup" aria-label="Show as">
              {(["table", "cards", "list"] as ViewKind[]).map((k) => (
                <button key={k} role="radio" aria-checked={view.kind === k} className={view.kind === k ? "on" : ""} onClick={() => setView((v) => ({ ...v, kind: k }))} title={k[0]!.toUpperCase() + k.slice(1)}>
                  <Icon name={k === "table" ? "table" : k === "cards" ? "split" : "list"} />
                </button>
              ))}
            </div>
            <input className="type-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${p.name}…`} aria-label="Filter" />
            <select value={view.group ?? ""} onChange={(e) => setView((v) => ({ ...v, group: e.target.value || null }))} aria-label="Group by">
              <option value="">No grouping</option>
              {groupable.map((x) => (
                <option key={x.name} value={x.name}>
                  Group by {x.name}
                </option>
              ))}
            </select>
            {canWrite && (
              <button className="quiet" onClick={() => void saveView()}>
                <Icon name="bookmark" size={16} /> Save view
              </button>
            )}
          </div>
          <div className="type-sections" role="group" aria-label="Show">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`chip${section === s.id ? " on" : ""}`} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
            {view.where.map((w) => (
              <button key={w.prop} className="chip on" onClick={() => setView((v) => ({ ...v, where: v.where.filter((x) => x !== w) }))} title="Remove this filter">
                {w.prop} is {w.value} ×
              </button>
            ))}
          </div>
        </div>

        {rows === null ? (
          <div className="loading-bar" />
        ) : rows.length === 0 ? (
          <p className="muted">No {p.name} notes yet.{type && canWrite ? ` Make one with “New ${type.name}”, or set a note's type from the chip above its title.` : ""}</p>
        ) : shown.length === 0 ? (
          <p className="muted">Nothing matches.</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="type-group">
              {view.group && (
                <h3>
                  {g.key} <span className="count">{g.rows.length}</span>
                </h3>
              )}
              {view.kind === "table" ? (
                <div className="type-table-wrap">
                  <table className="type-table">
                    <thead>
                      <tr>
                        <th>
                          <button onClick={() => sortBy("title")}>Title {view.sort?.prop === "title" ? (view.sort.dir === "asc" ? "↑" : "↓") : ""}</button>
                        </th>
                        {columns.map((c) => (
                          <th key={c.name}>
                            <button onClick={() => sortBy(c.name)}>
                              {c.name} {view.sort?.prop === c.name ? (view.sort.dir === "asc" ? "↑" : "↓") : ""}
                            </button>
                          </th>
                        ))}
                        <th className="muted">Changed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <button className="type-row-title" onClick={() => open(r.id)}>
                              {r.title}
                            </button>
                          </td>
                          {columns.map((c) => (
                            <td key={c.name}>
                              <Cell prop={c} value={r.frontmatter[c.name]} ro={!canWrite} notes={p.notes} vaultId={p.vault.id} onSet={(v) => void set(r, c.name, v)} onOpen={open} onFilter={(value) => setView((v) => ({ ...v, where: [...v.where.filter((w) => w.prop !== c.name), { prop: c.name, value }] }))} />
                            </td>
                          ))}
                          <td className="muted">{relativeTime(r.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : view.kind === "cards" ? (
                <div className="type-cards">
                  {g.rows.map((r) => (
                    <button key={r.id} className="type-card" onClick={() => open(r.id)}>
                      <b>{r.title}</b>
                      {columns.slice(0, 4).map((c) =>
                        text(r.frontmatter[c.name]) ? (
                          <span key={c.name}>
                            <small>{c.name}</small> {text(r.frontmatter[c.name])}
                          </span>
                        ) : null,
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <ul className="type-list">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <button onClick={() => open(r.id)}>
                        <span>{r.title}</span>
                        <small className="muted">{columns.map((c) => text(r.frontmatter[c.name])).filter(Boolean).slice(0, 3).join(" · ")}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** One editable property in the table: the right control for its kind. */
function Cell({ prop, value, ro, notes, vaultId, onSet, onOpen, onFilter }: { prop: TypeProp; value: unknown; ro: boolean; notes: NoteSummary[]; vaultId: number; onSet: (v: unknown) => void; onOpen: (id: number) => void; onFilter: (v: string) => void }) {
  if (prop.kind === "checkbox") return <input type="checkbox" checked={value === true} disabled={ro} onChange={(e) => onSet(e.target.checked)} aria-label={prop.name} />;
  if (prop.kind === "select")
    return (
      <span className="cell-select">
        <select value={text(value)} disabled={ro} onChange={(e) => onSet(e.target.value || null)} aria-label={prop.name}>
          <option value="">—</option>
          {[...new Set([...(prop.options ?? []), ...(text(value) ? [text(value)] : [])])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {text(value) && (
          <button className="icon-btn" onClick={() => onFilter(text(value))} title={`Only ${prop.name}: ${text(value)}`} aria-label={`Only ${prop.name} ${text(value)}`}>
            <Icon name="search" size={14} />
          </button>
        )}
      </span>
    );
  if (prop.kind === "relation") {
    const targets = linkTargets(value);
    const pick = async () => {
      const candidates = notes.filter((n) => !prop.type || (n.type ?? "").toLowerCase() === prop.type.toLowerCase());
      const choice = await chooseDialog({
        title: `${prop.name}: choose ${prop.type ? `a ${prop.type}` : "a note"}`,
        options: candidates.map((n) => ({ value: n.title, label: n.title, hint: n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined })),
        placeholder: `Find ${prop.type ? `a ${prop.type}` : "a note"}…`,
        empty: prop.type ? `No ${prop.type} notes match` : "No notes match",
      });
      if (!choice) return;
      const link = `[[${choice}]]`;
      onSet(prop.many ? [...(Array.isArray(value) ? value : value ? [value] : []), link] : link);
    };
    return (
      <span className="cell-relation">
        {targets.map((t) => {
          const hit = resolveLocal(notes, t);
          return (
            <button key={t} className="pill link-pill" onClick={() => hit && onOpen(hit.id)}>
              {t}
            </button>
          );
        })}
        {!ro && (
          <button className="icon-btn" onClick={() => void pick()} aria-label={`Set ${prop.name}`} title={`Set ${prop.name}`}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </span>
    );
  }
  return (
    <input
      className="cell-input"
      defaultValue={text(value)}
      key={text(value)}
      type={prop.kind === "number" ? "number" : prop.kind === "date" ? "date" : "text"}
      disabled={ro}
      aria-label={prop.name}
      onBlur={(e) => {
        const v = e.target.value;
        if (v === text(value)) return;
        onSet(prop.kind === "number" ? (v === "" ? null : Number(v)) : prop.kind === "list" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
