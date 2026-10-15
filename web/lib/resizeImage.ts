// Shrink photos in the browser before upload: a phone photo is 2–5 MB and the whole vault lives in
// Postgres. Photos (JPEG, HEIC) become JPEG with the longest side at most MAX_SIDE; PNG and WebP
// are only scaled down when oversized, and kept lossless (screenshots, transparency). Anything
// this can't decode (or doesn't shrink) is uploaded unchanged.

const MAX_SIDE = 2048;
const QUALITY = 0.82;
const SMALL_ENOUGH = 1_500_000; // bytes: a photo already this small and this size is left alone

/** The file to upload in place of `file`: shrunk as above, or `file` itself. */
export async function prepareImage(file: File): Promise<File> {
  const heic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  const photo = heic || /^image\/jpe?g$/i.test(file.type);
  const lossless = /^image\/(png|webp)$/i.test(file.type);
  if (!photo && !lossless) return file; // GIF (animation), SVG, PDFs…

  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && !heic && (lossless || file.size <= SMALL_ENOUGH)) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const type = photo ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, QUALITY));
  // HEIC must be converted (most browsers can't show it); otherwise only keep a smaller result.
  if (!blob || (!heic && blob.size >= file.size)) return file;
  const ext = photo ? ".jpg" : ".png";
  const name = /\.[^./]+$/.test(file.name) ? file.name.replace(/\.[^./]+$/, ext) : file.name + ext;
  return new File([blob], name, { type, lastModified: file.lastModified });
}
