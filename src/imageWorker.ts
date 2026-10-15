// A child process (src/images.ts): decode a HEIC or JPEG photo from stdin, apply its rotation,
// shrink the longest side to MAX_SIDE and write it to stdout as JPEG. A separate process, not a
// Worker, because only a process exiting gives the decoder's memory (hundreds of MB for a
// 12-megapixel photo) back to a 512 MB server; a Worker's stays with the server.
//
//   bun src/imageWorker.ts heic|jpeg < in > out.jpg
//
// Exits 3 without decoding when a photo is too big to decode safely in the memory there is
// (measured: a 24 MP HEIC peaks near 390 MB, a 24 MP JPEG near 490 MB); the caller keeps the
// original then.

import jpeg from "jpeg-js";
import { exifOrientation, jpegSize, orientAndShrink } from "./imageMath";

const MAX_SIDE = 2048;
const QUALITY = 82;
const MAX_MP = { heic: 25, jpeg: 16 }; // every iPhone default fits: 24 MP HEIC, 12 MP JPEG
const TOO_BIG = 3;

async function decodeHeic(bytes: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  // @ts-expect-error: libheif-js ships no types
  const libheif = (await import("libheif-js/wasm-bundle")).default;
  const [image] = new libheif.HeifDecoder().decode(bytes);
  if (!image) throw new Error("Not a HEIC image");
  const width: number = image.get_width();
  const height: number = image.get_height();
  if (width * height > MAX_MP.heic * 1e6) process.exit(TOO_BIG);
  // libheif applies the photo's rotation itself.
  const data = await new Promise<Uint8ClampedArray>((resolve, reject) =>
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d: { data: Uint8ClampedArray } | null) => (d ? resolve(d.data) : reject(new Error("HEIC decode failed")))),
  );
  return { data, width, height };
}

const kind = process.argv[2] === "heic" ? "heic" : "jpeg";
try {
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  let img: { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
  let orientation = 1;
  if (kind === "heic") img = await decodeHeic(bytes);
  else {
    const size = jpegSize(bytes);
    if (!size || size.width * size.height > MAX_MP.jpeg * 1e6) process.exit(TOO_BIG);
    orientation = exifOrientation(bytes);
    img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MP.jpeg, maxMemoryUsageInMB: 400 });
  }
  const out = orientAndShrink(img.data, img.width, img.height, orientation, MAX_SIDE);
  const encoded = jpeg.encode({ data: out.data, width: out.width, height: out.height }, QUALITY);
  await Bun.write(Bun.stdout, encoded.data);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
