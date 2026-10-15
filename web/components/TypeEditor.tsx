// The type editor (F16): at the top of a type's own note (Types/Person.md), a form for its icon,
// colour and properties, so nobody has to write YAML. Each change saves on its own, merged into
// live typing (PUT …/types/:name); the note below it stays the template for new notes of the type.

import { useEffect, useRef, useState } from "react";
import { PROP_KINDS, type PropKind, TYPE_COLOURS, TYPE_ICONS, type TypeProp, type TypeShape } from "../../src/types";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { loadTypes, setProperties, typeNamed, typeUrl, useTypes } from "../lib/types";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";

const KIND_LABEL: Record<PropKind, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  list: "List",
  select: "Choice",
  relation: "Link to…",
};

export function TypeEditor({ vaultId, name, readOnly }: { vaultId: number; name: string; readOnly: boolean }) {
  const { types } = useTypes();
  const def = typeNamed(name);
  const [shape, setShape] = useState<TypeShape | null>(def ? { icon: def.icon, colour: def.colour, properties: def.properties, cards: def.cards } : null);
  const timer = useRef<Timer | undefined>(undefined);
  const dirty = useRef(false);

  // Follow edits made elsewhere (another person, the YAML), unless a save of ours is waiting.
  useEffect(() => {
    if (def && !dirty.current) setShape({ icon: def.icon, colour: def.colour, properties: def.properties, cards: def.cards });
  }, [JSON.stringify(def && [def.icon, def.colour, def.properties, def.cards])]);

  if (!def || !shape) return null;

  const save = (next: TypeShape, now = false) => {
    setShape(next);
    dirty.current = true;
    clearTimeout(timer.current);
    const run = async () => {
      try {
        await api(`/vaults/${vaultId}/types/${encodeURIComponent(def.name)}`, { method: "PUT", body: next });
        await loadTypes(vaultId);
      } catch (e) {
        toastError(e);
      } finally {
        dirty.current = false;
      }
    };
    if (now) void run();
    else timer.current = setTimeout(() => void run(), 500);
  };
  const setProp = (i: number, patch: Partial<TypeProp>, now = false) => save({ ...shape, properties: shape.properties.map((p, j) => (j === i ? { ...p, ...patch } : p)) }, now);
  const move = (i: number, by: number) => {
    const ps = [...shape.properties];
    const [p] = ps.splice(i, 1);
    ps.splice(i + by, 0, p!);
    save({ ...shape, properties: ps }, true);
  };

  /** Renaming a property: notes of this type that already have it can follow. */
  async function renamed(i: number, from: string) {
    const to = shape!.properties[i]!.name.trim();
    if (!from || !to || from === to) return;
    const { notes } = await api<{ notes: { id: number; frontmatter: Record<string, unknown> }[] }>(`/vaults/${vaultId}/types/${encodeURIComponent(def!.name)}`);
    const having = notes.filter((n) => from in n.frontmatter && !(to in n.frontmatter));
    if (!having.length) return;
    const yes = await confirmDialog({ title: `Rename “${from}” in ${having.length} ${def!.name} note${having.length === 1 ? "" : "s"} too?`, message: `They keep their values, under “${to}”.`, action: "Rename in notes" });
    if (!yes) return;
    try {
      for (const n of having) await setProperties(vaultId, n.id, { [to]: n.frontmatter[from] as any, [from]: null });
      toast(`Renamed “${from}” to “${to}” in ${having.length} note${having.length === 1 ? "" : "s"}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function rename() {
    const to = await promptDialog({ title: `Rename the ${def!.name} type`, message: "Every note of this type, and links to it from other types, follow.", label: "Name", value: def!.name, action: "Rename" });
    if (!to || to === def!.name) return;
    try {
      const r = await api<{ changed: number }>(`/vaults/${vaultId}/types/${encodeURIComponent(def!.name)}/rename`, { body: { to } });
      await loadTypes(vaultId);
      toast(`Renamed to ${to}${r.changed ? `, and updated ${r.changed} note${r.changed === 1 ? "" : "s"}` : ""}`);
    } catch (e) {
      toastError(e);
    }
  }

  const others = types.map((t) => t.name);

  return (
    <section className={`type-editor colour-${shape.colour}`} aria-label={`The ${def.name} type`}>
      <div className="type-editor-head">
        <Menu
          label="Icon"
          className="type-icon-btn"
          trigger={<Icon name={shape.icon} size={22} />}
          items={() => TYPE_ICONS.map((icon) => ({ label: icon, icon, onSelect: () => !readOnly && save({ ...shape, icon }, true) }))}
        />
        <div className="type-editor-title">
          <span className="eyebrow">Type</span>
          <b>{def.name}</b>
        </div>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {TYPE_COLOURS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={shape.colour === c}
              aria-label={c}
              title={c}
              disabled={readOnly}
              className={`swatch colour-${c}${shape.colour === c ? " on" : ""}`}
              onClick={() => save({ ...shape, colour: c }, true)}
            />
          ))}
        </div>
        <div className="type-editor-actions">
          <button className="quiet" onClick={() => navigate(typeUrl(vaultId, def.name))}>
            <Icon name="list" size={16} /> {def.count} {def.count === 1 ? "note" : "notes"}
          </button>
          {!readOnly && (
            <button className="quiet" onClick={() => void rename()}>
              <Icon name="edit" size={16} /> Rename
            </button>
          )}
        </div>
      </div>

      <h4>Properties every {def.name} has</h4>
      <ol className="type-props">
        {shape.properties.map((p, i) => (
          <li key={i} className="type-prop">
            <PropName value={p.name} readOnly={readOnly} onChange={(n) => setProp(i, { name: n })} onDone={(from) => void renamed(i, from)} />
            <select value={p.kind} disabled={readOnly} aria-label={`${p.name || "Property"}: kind`} onChange={(e) => setProp(i, { kind: e.target.value as PropKind }, true)}>
              {PROP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            {p.kind === "select" && <Choices options={p.options ?? []} readOnly={readOnly} onChange={(options) => setProp(i, { options }, true)} />}
            {p.kind === "relation" && (
              <span className="type-prop-relation">
                <select value={p.type ?? ""} disabled={readOnly} aria-label={`${p.name}: links to`} onChange={(e) => setProp(i, { type: e.target.value || undefined }, true)}>
                  <option value="">any note</option>
                  {[...new Set([...others, ...(p.type ? [p.type] : [])])].map((t) => (
                    <option key={t} value={t}>
                      a {t}
                    </option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={!!p.many} disabled={readOnly} onChange={(e) => setProp(i, { many: e.target.checked }, true)} /> more than one
                </label>
              </span>
            )}
            {!readOnly && (
              <span className="type-prop-tools">
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${p.name} up`} title="Move up">
                  <Icon name="chevron-left" size={14} />
                </button>
                <button className="icon-btn" disabled={i === shape.properties.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${p.name} down`} title="Move down">
                  <Icon name="chevron" size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => {
                    const before = shape;
                    save({ ...shape, properties: shape.properties.filter((_, j) => j !== i) }, true);
                    toast(`Removed “${p.name}” from the type. Notes keep their values.`, { undo: () => save(before, true) });
                  }}
                  aria-label={`Remove ${p.name}`}
                  title="Remove"
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!readOnly && (
        <div className="add-prop">
          <button className="quiet" onClick={() => save({ ...shape, properties: [...shape.properties, { name: newName(shape.properties), kind: "text" }] }, true)}>
            <Icon name="plus" size={16} /> Add a property
          </button>
        </div>
      )}
      <label className="check type-cards-setting">
        <input type="checkbox" checked={shape.cards !== false} disabled={readOnly} onChange={(e) => save({ ...shape, cards: e.target.checked }, true)} /> Show a link to a {def.name} on a line of its own as a card, with its key
        properties
      </label>
      <p className="muted type-editor-hint">Below is the template: what every new {def.name} starts with. {"{{title}}"} and {"{{date}}"} are filled in.</p>
    </section>
  );
}

const newName = (props: TypeProp[]) => {
  for (let i = 1; ; i++) {
    const n = i === 1 ? "property" : `property ${i}`;
    if (!props.some((p) => p.name === n)) return n;
  }
};

/** A property's name: saved as you type, and on leaving, offered to notes that have the old one. */
function PropName({ value, readOnly, onChange, onDone }: { value: string; readOnly: boolean; onChange: (v: string) => void; onDone: (from: string) => void }) {
  const start = useRef(value);
  return (
    <input
      className="type-prop-name"
      value={value}
      disabled={readOnly}
      aria-label="Property name"
      spellCheck={false}
      onFocus={() => (start.current = value)}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onDone(start.current)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** A choice property's options as pills; type and press Enter to add one. */
function Choices({ options, readOnly, onChange }: { options: string[]; readOnly: boolean; onChange: (o: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const fresh = draft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !options.includes(s));
    setDraft("");
    if (fresh.length) onChange([...options, ...fresh]);
  };
  return (
    <span className="prop-pills type-choices">
      {options.map((o) => (
        <span key={o} className="pill">
          {o}
          {!readOnly && (
            <button type="button" className="pill-x" onClick={() => onChange(options.filter((x) => x !== o))} aria-label={`Remove ${o}`}>
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          className="prop-pill-input"
          value={draft}
          placeholder={options.length ? "Add…" : "Add choices…"}
          aria-label="Add a choice"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      )}
    </span>
  );
}
