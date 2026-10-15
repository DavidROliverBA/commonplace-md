// Writes web/apple-touch-icon.png (180×180): iOS ignores SVG touch icons. A tiny PNG encoder —
// rasterises the same shapes as web/icon.svg with 4× supersampling — so no image tooling is needed.
import { deflateSync } from "node:zlib";

const S = 180, SS = 4;
const px = new Uint8Array(S * S * 4);
const purple = [0x6d, 0x5b, 0xd0], white = [255, 255, 255], lilac = [0xd9, 0xd3, 0xf7];
const scale = S / 64;
function colourAt(x: number, y: number): number[] {
  // in 64-unit icon space
  const u = x / scale, v = y / scale;
  const node = (cx: number, cy: number) => (u - cx) ** 2 + (v - cy) ** 2 < 3.2 ** 2;
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(u - (x1 + t * dx), v - (y1 + t * dy)) < 0.9;
  };
  const inPage = u >= 16 && u <= 48 && v >= 14 && v <= 52 && !(u > 38 && v < 14 + (u - 38));
  const inFold = u >= 38 && u <= 48 && v >= 14 && v <= 24 && v >= 14 + (u - 38);
  if (node(26, 36) || node(38, 32) || node(32, 44) || seg(26, 36, 38, 32) || seg(26, 36, 32, 44) || seg(38, 32, 32, 44)) return purple;
  if (inFold) return lilac;
  if (inPage) return white;
  return purple;
}
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const c = colourAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        acc[0]! += c[0]!; acc[1]! += c[1]!; acc[2]! += c[2]!;
      }
    const i = (y * S + x) * 4;
    px[i] = acc[0]! / SS / SS; px[i + 1] = acc[1]! / SS / SS; px[i + 2] = acc[2]! / SS / SS; px[i + 3] = 255;
  }
const raw = new Uint8Array(S * (S * 4 + 1));
for (let y = 0; y < S; y++) raw.set(px.subarray(y * S * 4, (y + 1) * S * 4), y * (S * 4 + 1) + 1);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}
const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
dv.setUint32(0, S); dv.setUint32(4, S); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
await Bun.write(new URL("../web/apple-touch-icon.png", import.meta.url), png);
console.log("wrote web/apple-touch-icon.png");
