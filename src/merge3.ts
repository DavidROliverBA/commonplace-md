// A three-way line merge (diff3), for "Update from main" on a GitHub vault (F14): a note changed
// both here and on GitHub since the base takes both sets of changes when they touch different
// lines, and is a clash when they change the same lines differently. A clash is never written into the note as <<<<<<<
// markers: the caller keeps our text and offers a choice.

const MAX_CELLS = 4_000_000;

const split = (t: string) => (t === "" ? [] : t.split("\n"));

/** For each line of `a`, the index of the line of `b` it's matched with (longest common
 *  subsequence), or -1. Null when the files are too big to compare. */
function matches(a: string[], b: string[]): Int32Array | null {
  const out = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) out[start] = start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
    out[a.length - 1 - end] = b.length - 1 - end;
    end++;
  }
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if (!x.length || !y.length) return out;
  if (x.length * y.length > MAX_CELLS) return null;
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out[start + i++] = start + j++;
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** Merge `ours` and `theirs`, both changed from `base`. `clean` is false when they changed the
 *  same lines differently; `text` is then meaningless. */
export function merge3(base: string, ours: string, theirs: string): { clean: boolean; text: string } {
  if (ours === theirs || theirs === base) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  const b = split(base);
  const o = split(ours);
  const t = split(theirs);
  const mo = matches(b, o);
  const mt = matches(b, t);
  if (!mo || !mt) return { clean: false, text: ours };
  const out: string[] = [];
  let ib = 0;
  let io = 0;
  let it = 0;
  for (;;) {
    // Lines unchanged on both sides.
    while (ib < b.length && mo[ib] === io && mt[ib] === it) {
      out.push(b[ib]!);
      ib++;
      io++;
      it++;
    }
    if (ib >= b.length && io >= o.length && it >= t.length) break;
    // The next base line both sides kept, where they line up again.
    let k = ib;
    while (k < b.length && (mo[k]! < io || mt[k]! < it)) k++;
    const [eb, eo, et] = k < b.length ? [k, mo[k]!, mt[k]!] : [b.length, o.length, t.length];
    const cb = b.slice(ib, eb);
    const co = o.slice(io, eo);
    const ct = t.slice(it, et);
    if (same(co, cb)) out.push(...ct);
    else if (same(ct, cb) || same(co, ct)) out.push(...co);
    else return { clean: false, text: ours };
    ib = eb;
    io = eo;
    it = et;
  }
  return { clean: true, text: out.join("\n") };
}
