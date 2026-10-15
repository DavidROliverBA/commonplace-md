// A line diff for previewing an assistant's change before it's applied (F13). Longest common
// subsequence over lines, with unchanged runs folded down to a little context either side.

export type DiffLine = { kind: "same" | "add" | "del"; text: string } | { kind: "gap"; count: number };

const CONTEXT = 2;
const MAX_CELLS = 4_000_000; // beyond this, show it as replaced rather than freeze the page

export function lineDiff(before: string, after: string): DiffLine[] {
  const lines = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = lines(before);
  const b = lines(after);
  // Trim the shared start and end first: most edits touch a small part of a note.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);

  const middle: DiffLine[] = [];
  if (x.length * y.length > MAX_CELLS) {
    middle.push(...x.map((text) => ({ kind: "del" as const, text })), ...y.map((text) => ({ kind: "add" as const, text })));
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) middle.push({ kind: "same", text: x[i++]! }), j++;
      // Removed lines before the lines that replace them.
      else if (i < x.length && (j >= y.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) middle.push({ kind: "del", text: x[i++]! });
      else middle.push({ kind: "add", text: y[j++]! });
    }
  }
  const all: DiffLine[] = [...a.slice(0, start).map((text) => ({ kind: "same" as const, text })), ...middle, ...a.slice(a.length - end).map((text) => ({ kind: "same" as const, text }))];
  return fold(all);
}

function fold(lines: DiffLine[]): DiffLine[] {
  const changed = lines.map((l) => l.kind === "add" || l.kind === "del");
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  const out: DiffLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "same" || near(i)) out.push(lines[i]!);
    else {
      const last = out[out.length - 1];
      if (last?.kind === "gap") last.count++;
      else out.push({ kind: "gap", count: 1 });
    }
  }
  return out;
}

/** "3 lines added, 1 removed". */
export function diffStats(d: DiffLine[]): string {
  const add = d.filter((l) => l.kind === "add").length;
  const del = d.filter((l) => l.kind === "del").length;
  const p = (n: number, w: string) => `${n} line${n === 1 ? "" : "s"} ${w}`;
  return [add && p(add, "added"), del && p(del, "removed")].filter(Boolean).join(", ") || "No change";
}
