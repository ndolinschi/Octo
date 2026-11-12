/**
 * B12: what the composer does with an image before it goes up. Pure decisions (the canvas work is in the chat's
 * `useImages`): the harness takes PNG, JPEG, WebP and GIF up to 5 MB, and a model gains nothing from more than 2 048 px on
 * the long side, so a larger picture is scaled down first. At most eight go with one message.
 */
export const IMAGE_MAX_SIDE = 2048;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;

const SENDABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const isImageType = (type: string) => type.startsWith("image/");

/** The size an image is drawn at: the long side at most `IMAGE_MAX_SIDE`, the shape kept; `scaled` says whether it changed. */
export function fitSize(width: number, height: number, max = IMAGE_MAX_SIDE): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width, height, scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/** Send as is, or draw again (too large in pixels or bytes, or a type the harness does not take: bmp, avif, heic). */
export function planImage(input: { type: string; bytes: number; width: number; height: number }): "keep" | "redraw" {
  if (!SENDABLE.has(input.type)) return "redraw";
  if (fitSize(input.width, input.height).scaled || input.bytes > IMAGE_MAX_BYTES) return "redraw";
  return "keep";
}

/** The type a redrawn image is written in: GIF and PNG stay lossless, everything else is JPEG (small). */
export function redrawType(type: string): "image/png" | "image/jpeg" {
  return type === "image/png" || type === "image/gif" ? "image/png" : "image/jpeg";
}

/** JPEG qualities to try in turn until the result fits `IMAGE_MAX_BYTES`. */
export const JPEG_QUALITIES = [0.9, 0.8, 0.65, 0.5] as const;

/** How many of `incoming` fit beside `have` already attached (the rest are said, not silently dropped). */
export function room(have: number, incoming: number): { take: number; over: number } {
  const take = Math.max(0, Math.min(incoming, IMAGE_MAX_COUNT - have));
  return { take, over: incoming - take };
}

/** "3.2 MB" / "480 KB" for a chip. */
export function imageSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
