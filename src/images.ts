// Server-side photo preparation for uploads that don't come through the browser (the iPhone
// Shortcut today, native apps later). The web client already shrinks photos itself
// (web/lib/resizeImage.ts); this does the same here: HEIC becomes JPEG (Chrome can't show HEIC),
// big JPEGs shrink to 2048 px, upright. One photo at a time, each in a short-lived child process
// (src/imageWorker.ts), so a 12-megapixel decode can't leave its memory behind on a 512 MB server.

const SMALL_ENOUGH = 1_500_000; // a JPEG this small is left alone
const TIMEOUT_MS = 30_000;
const MAX_INPUT = 20 * 1024 * 1024; // bigger than any iPhone photo; don't even try

let queue: Promise<unknown> = Promise.resolve();

const WORKER = new URL("./imageWorker.ts", import.meta.url).pathname;

async function convert(bytes: ArrayBuffer, kind: "heic" | "jpeg"): Promise<ArrayBuffer> {
  const proc = Bun.spawn([process.execPath, WORKER, kind], { stdin: new Uint8Array(bytes), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 3) throw new Error("too large to convert safely; kept as it is");
    if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const isHeic = (f: File) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isJpeg = (f: File) => /^image\/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name);

/**
 * A photo ready for the vault: HEIC → JPEG, large JPEG → 2048 px JPEG. Anything else, or a
 * photo that can't be decoded, comes back unchanged (it's still saved, never lost).
 */
export async function preparePhoto(file: File): Promise<File> {
  const heic = isHeic(file);
  if (!heic && !(isJpeg(file) && file.size > SMALL_ENOUGH)) return file;
  if (file.size > MAX_INPUT) return file;
  const job = queue.then(async () => {
    const out = await convert(await file.arrayBuffer(), heic ? "heic" : "jpeg");
    if (!heic && out.byteLength >= file.size) return file;
    const name = file.name.replace(/\.[^./]+$/, "") + ".jpg";
    return new File([out], name, { type: "image/jpeg", lastModified: file.lastModified });
  });
  queue = job.catch(() => {});
  try {
    return await job;
  } catch (err) {
    console.error(`photo conversion failed (${file.name}):`, err instanceof Error ? err.message : err);
    return file;
  }
}
