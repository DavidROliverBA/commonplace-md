// "New type" (F16): start from a ready-made type (Person, Meeting, Project, Book…) or a blank one.
// Adding a starter also adds the starters its links need (a Meeting's attendees are People).

import { useEffect, useState } from "react";
import { STARTERS } from "../../src/types";
import { addStarters, createType, loadTypes, typesState, useTypes } from "../lib/types";
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
      const added = await addStarters(vaultId, [starterName]);
      const extra = added.filter((n) => n !== starterName);
      toast(extra.length ? `Added ${starterName}, and ${extra.join(" and ")} for its links` : `Added the ${starterName} type`);
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
