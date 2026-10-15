// Photo preparation for captured photos: EXIF rotation, size limits, shrinking, and the HEIC
// path end to end (src/imageMath.ts, src/images.ts). No database needed; the HEIC case runs only
// where macOS `sips` can make a HEIC, and is skipped elsewhere.

import { describe, expect, test } from "bun:test";
import jpeg from "jpeg-js";
import { exifOrientation, jpegSize, orientAndShrink } from "../src/imageMath";
import { preparePhoto } from "../src/images";

/** A JPEG with an EXIF APP1 segment holding just an orientation tag. */
function withOrientation(jpg: Uint8Array, orientation: number, littleEndian = false): Uint8Array {
  const tiff = littleEndian
    ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + TIFF
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...body, ...jpg.subarray(2)]);
}

/** RGBA pixels where each pixel's red channel is its index, so positions can be checked. */
function indexed(w: number, h: number) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d[i * 4] = i;
  return d;
}
const reds = (o: { data: Uint8Array; width: number; height: number }) => {
  const rows: number[][] = [];
  for (let y = 0; y < o.height; y++) rows.push([...Array(o.width)].map((_, x) => o.data[(y * o.width + x) * 4]!));
  return rows;
};

describe("photo preparation", () => {
  const small = new Uint8Array(jpeg.encode({ data: Buffer.alloc(3 * 2 * 4, 200), width: 3, height: 2 }, 90).data);

  test("reads the JPEG frame size and the EXIF orientation, in either byte order", () => {
    expect(jpegSize(small)).toEqual({ width: 3, height: 2 });
    expect(exifOrientation(small)).toBe(1);
    expect(exifOrientation(withOrientation(small, 6))).toBe(6);
    expect(exifOrientation(withOrientation(small, 8, true))).toBe(8);
    expect(jpegSize(withOrientation(small, 6))).toEqual({ width: 3, height: 2 });
    expect(exifOrientation(new Uint8Array([1, 2, 3]))).toBe(1);
  });

  test("turns all eight orientations upright", () => {
    // Source, 3 wide × 2 high:  0 1 2 / 3 4 5
    const src = indexed(3, 2);
    const at = (o: number) => reds(orientAndShrink(src, 3, 2, o, 100));
    expect(at(1)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(at(2)).toEqual([[2, 1, 0], [5, 4, 3]]); // mirrored
    expect(at(3)).toEqual([[5, 4, 3], [2, 1, 0]]); // 180°
    expect(at(4)).toEqual([[3, 4, 5], [0, 1, 2]]); // flipped
    expect(at(5)).toEqual([[0, 3], [1, 4], [2, 5]]); // transposed
    expect(at(6)).toEqual([[3, 0], [4, 1], [5, 2]]); // 90° clockwise (the usual portrait photo)
    expect(at(7)).toEqual([[5, 2], [4, 1], [3, 0]]);
    expect(at(8)).toEqual([[2, 5], [1, 4], [0, 3]]); // 90° anticlockwise
  });

  test("shrinks the longest side to the limit by averaging, keeping the shape", () => {
    const d = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < 8; i++) d.set([i % 2 ? 200 : 100, 0, 0, 255], i * 4); // columns alternate 100/200
    const o = orientAndShrink(d, 4, 2, 1, 2);
    expect([o.width, o.height]).toEqual([2, 1]);
    expect(o.data[0]).toBe(150); // averaged, not sampled
    const portrait = orientAndShrink(new Uint8Array(4000 * 3000 * 4), 4000, 3000, 6, 2048);
    expect([portrait.width, portrait.height]).toEqual([1536, 2048]);
  });

  test("a HEIC photo becomes an upright 2048 px JPEG; small JPEGs and other files pass through", async () => {
    // Build a real HEIC with macOS sips if it's there; elsewhere this case is skipped.
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/cp-heic-${process.pid}`;
    // Noise, so the JPEG is a phone-photo-sized few MB (a flat colour compresses to nothing).
    const noise = Buffer.alloc(3000 * 2000 * 4);
    for (let i = 0, x = 7; i < noise.length; i++) noise[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
    const big = new Uint8Array(jpeg.encode({ data: noise, width: 3000, height: 2000 }, 90).data);
    expect(big.length).toBeGreaterThan(1_500_000);
    await Bun.write(`${tmp}.jpg`, big);
    const sips = Bun.which("sips") ? Bun.spawnSync(["sips", "-s", "format", "heic", `${tmp}.jpg`, "--out", `${tmp}.heic`], { stdout: "ignore", stderr: "ignore" }) : null;
    if (sips?.exitCode === 0) {
      const heic = new File([await Bun.file(`${tmp}.heic`).arrayBuffer()], "IMG_0001.HEIC", { type: "image/heic" });
      const out = await preparePhoto(heic);
      expect([out.name, out.type]).toEqual(["IMG_0001.jpg", "image/jpeg"]);
      expect(jpegSize(new Uint8Array(await out.arrayBuffer()))).toEqual({ width: 2048, height: 1365 });
    }
    // A big JPEG with a portrait EXIF tag comes out upright and shrunk.
    const tagged = withOrientation(big, 6);
    const shrunk = await preparePhoto(new File([tagged as Uint8Array<ArrayBuffer>], "IMG_0002.JPG", { type: "image/jpeg" }));
    expect(jpegSize(new Uint8Array(await shrunk.arrayBuffer()))).toEqual({ width: 1365, height: 2048 });
    expect(shrunk.size).toBeLessThan(tagged.length);
    // Small photos, PNGs and anything undecodable are kept exactly.
    const tiny = new File([small], "a.jpg", { type: "image/jpeg" });
    expect(await preparePhoto(tiny)).toBe(tiny);
    const png = new File([new Uint8Array(10)], "s.png", { type: "image/png" });
    expect(await preparePhoto(png)).toBe(png);
    const broken = new File([new Uint8Array(2_000_000)], "bad.heic", { type: "image/heic" });
    expect(await preparePhoto(broken)).toBe(broken);
  }, 30000);
});
