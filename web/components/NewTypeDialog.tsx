// "New type" (F16): start from a ready-made type (Person, Meeting, Project, Book…) or a blank one.
// Adding a starter also adds the starters its links need (a Meeting's attendees are People).

import { useEffect, useState } from "react";
import { normalisePath } from "../../src/markdown";
import { STARTERS, starterNeeds, starterNote, TYPES_FOLDER } from "../../src/types";
import { api, type Note } from "../lib/api";
import { createType, loadTypes, typesState, useTypes } from "../lib/types";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { toast, toastError } from "../ui/overlays";

export function NewTypeDialog({ vaultId, onClose, onOpen }: { vaultId: number; onClose: () => void; onOpen: (noteId: number) => void }) {
  const { types } = useTypes();
  const has = (name: string) => types.some((t) => t.name.toLowerCase() === name.toLowerCase());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Fresh from the server, so a type made a moment ago (here or elsewhere) shows as added.
  const [ready, setReady] = useState(() => typesState().vaultId === vaultId);
  useEffect(() => {
    loadTypes(vaultId).then(() => setReady(true), () => setReady(true));
  }, [vaultId]);

  async function addStarter(starterName: string) {
    setBusy(true);
    try {
      const s = STARTERS.find((x) => x.name === starterName)!;
      const needed = starterNeeds(s).filter((n) => !has(n));
      let first: Note | null = null;
      for (const n of [s.name, ...needed]) {
        const st = STARTERS.find((x) => x.name === n)!;
        const made = await api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(`${TYPES_FOLDER}/${st.name}`), content: starterNote(st) } });
        first ??= made;
      }
      await loadTypes(vaultId);
      toast(needed.length ? `Added ${s.name}, and ${needed.join(" and ")} for its links` : `Added the ${s.name} type`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function blank() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const n = await createType(vaultId, name.trim());
      onClose();
      onOpen(n.id);
      toast(`Made the ${name.trim()} type. Add its properties here.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New type" onClose={onClose} size="wide">
      <p className="muted">A type says what a note is: a Person, a Meeting, a Book. Each type has its own properties, template and page. Start from one of these, or make your own.</p>
      <ul className="starters">
        {STARTERS.map((s) => {
          const added = has(s.name);
          return (
            <li key={s.name} className={`starter colour-${s.shape.colour}`}>
              <div className="starter-head">
                <Icon name={s.shape.icon} size={20} />
                <b>{s.name}</b>
              </div>
              <p>{s.about}</p>
              <p className="starter-props">{s.shape.properties.map((p) => p.name).join(" · ")}</p>
              <button className={added ? "" : "primary"} disabled={added || busy || !ready} onClick={() => void addStarter(s.name)}>
                {added ? (
                  <>
                    <Icon name="check-plain" size={16} /> Added
                  </>
                ) : (
                  `Add ${s.name}`
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="row new-type-blank"
        onSubmit={(e) => {
          e.preventDefault();
          void blank();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Or name your own: Recipe, Place, Car…" aria-label="New type's name" />
        <button type="submit" disabled={!name.trim() || busy}>
          Make it
        </button>
      </form>
      <div className="dialog-actions">
        <button onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
