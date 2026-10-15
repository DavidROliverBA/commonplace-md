// Choosing a template and reading it, for "Insert template…" and "New note from template…".

import { chooseDialog, toast } from "../ui/overlays";
import { api, type Note, type NoteSummary } from "./api";
import { isTemplate, TEMPLATE_FOLDER } from "./templates";

export const templatesIn = (notes: NoteSummary[]) => notes.filter((n) => isTemplate(n.path)).sort((a, b) => a.title.localeCompare(b.title));

/** Ask which template, then fetch its text. Null if cancelled, or if there are no templates. */
export async function pickTemplate(vaultId: number, notes: NoteSummary[]): Promise<{ note: NoteSummary; text: string } | null> {
  const list = templatesIn(notes);
  if (!list.length) {
    toast(`No templates yet: any note in a “${TEMPLATE_FOLDER}” folder is one. {{title}}, {{date}} and {{time}} are filled in.`);
    return null;
  }
  const id = await chooseDialog({
    title: "Choose a template",
    options: list.map((n) => ({ value: String(n.id), label: n.title, icon: "file", hint: n.path.split("/").slice(1, -1).join("/") || undefined })),
    placeholder: "Find a template…",
  });
  if (!id) return null;
  const note = list.find((n) => String(n.id) === id)!;
  const full = await api<Note>(`/vaults/${vaultId}/notes/${note.id}`);
  return { note, text: full.content };
}
