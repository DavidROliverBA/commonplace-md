// Pure pixel helpers for src/imageWorker.ts, kept separate so they're unit-tested.

/** The EXIF orientation (1–8) of a JPEG, or 1 when it has none. */
export function exifOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xda) break; // image data starts: no more metadata
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif") {
      const t = i + 10; // TIFF header
      const le = b[t] === 0x49; // "II" little-endian, "MM" big-endian
      const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
      const u32 = (o: number) => (le ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000 : b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!));
      const ifd = t + u32(t + 4);
      const count = u16(ifd);
      for (let n = 0; n < count; n++) {
        const entry = ifd + 2 + n * 12;
        if (entry + 12 > b.length) break;
        if (u16(entry) === 0x0112) {
          const v = u16(entry + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** A JPEG's pixel size from its frame header, without decoding it; null if there isn't one. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= b.length && b[i] === 0xff) {
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
  }
  return null;
}

/**
 * Rotate/flip RGBA pixels upright for an EXIF orientation and shrink so the longest side is at
 * most `maxSide`, averaging each block of source pixels (no jagged edges on a 2–3× reduction).
 */
export function orientAndShrink(src: Uint8Array | Uint8ClampedArray, w: number, h: number, orientation: number, maxSide: number) {
  const swap = orientation >= 5;
  const ow = swap ? h : w; // upright size
  const oh = swap ? w : h;
  const scale = Math.min(1, maxSide / Math.max(ow, oh));
  const W = Math.max(1, Math.round(ow * scale));
  const H = Math.max(1, Math.round(oh * scale));
  // Upright (X, Y) → source (x, y), for the eight EXIF orientations.
  const map = (X: number, Y: number): number => {
    let x = X;
    let y = Y;
    switch (orientation) {
      case 2: x = w - 1 - X; break;
      case 3: x = w - 1 - X; y = h - 1 - Y; break;
      case 4: y = h - 1 - Y; break;
      case 5: x = Y; y = X; break;
      case 6: x = Y; y = h - 1 - X; break;
      case 7: x = w - 1 - Y; y = h - 1 - X; break;
      case 8: x = w - 1 - Y; y = X; break;
    }
    return (y * w + x) * 4;
  };
  const out = new Uint8Array(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * oh) / H);
    const y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * oh) / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * ow) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((X + 1) * ow) / W));
      let r = 0, g = 0, bl = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = map(xx, yy);
          r += src[s]!;
          g += src[s + 1]!;
          bl += src[s + 2]!;
          n++;
        }
      }
      const d = (Y * W + X) * 4;
      out[d] = r / n;
      out[d + 1] = g / n;
      out[d + 2] = bl / n;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}
