// Yjs helpers shared by the live rooms (collab.ts) and offline writes (notes.ts).

import * as Y from "yjs";

/** Apply `next` to a Y.Text as a single splice over the changed middle, so cursors elsewhere survive. */
export function applyTextDiff(text: Y.Text, next: string): void {
  const cur = text.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  // Don't split a surrogate pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(cur[start - 1]!)) start--;
  // ...at either end: a shared low surrogate would otherwise be left orphaned.
  if (endCur < cur.length && /[\uDC00-\uDFFF]/.test(cur[endCur]!)) {
    endCur++;
    endNext++;
  }
  if (endCur - start > 0) text.delete(start, endCur - start);
  if (endNext - start > 0) text.insert(start, next.slice(start, endNext));
}

/** Build the Yjs doc for a note from its stored state, or from its text if it has none yet. */
export function loadDoc(content: string, ydoc: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  if (ydoc) Y.applyUpdate(doc, ydoc);
  // Belt and braces: the stored text is authoritative if the two ever disagree.
  if (text.toString() !== content) doc.transact(() => applyTextDiff(text, content), "server");
  return doc;
}

/** Text change for a note with no open room: diff it into the stored CRDT state. */
export function rebaseStoredDoc(content: string, ydoc: Uint8Array | null, next: string): Uint8Array {
  const doc = loadDoc(content, ydoc);
  doc.transact(() => applyTextDiff(doc.getText("content"), next), "server");
  return Y.encodeStateAsUpdate(doc);
}

