import { fitSize, imageSize, IMAGE_MAX_BYTES, JPEG_QUALITIES, planImage, redrawType } from "../../lib/images";

// The canvas work, loaded when the first picture is attached (not part of the entry bundle).

/** Draws `file` again within the limits (long side 2 048 px, at most 5 MB); the original when it already fits. */
export async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    if (planImage({ type: file.type, bytes: file.size, width: bitmap.width, height: bitmap.height }) === "keep") return { blob: file, name: file.name };
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot resize pictures");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const type = redrawType(file.type);
    const toBlob = (q?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
    let blob = await toBlob(0.9);
    for (const q of type === "image/jpeg" ? JPEG_QUALITIES : []) {
      if (blob && blob.size <= IMAGE_MAX_BYTES) break;
      blob = await toBlob(q);
    }
    if (!blob || blob.size > IMAGE_MAX_BYTES) throw new Error(`${file.name} is still larger than ${imageSize(IMAGE_MAX_BYTES)} after scaling`);
    const base = file.name.replace(/\.[^.]+$/, "");
    return { blob, name: `${base}.${type === "image/png" ? "png" : "jpg"}` };
  } finally {
    bitmap.close();
  }
}
