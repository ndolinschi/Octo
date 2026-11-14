/** Image formats the Files view previews (walk B15), by extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media type of a previewable image, or null when the path is not one. */
export function imageType(path: string): string | null {
  return IMAGE_TYPES[extension(path)] ?? null;
}

/** SVG is text: it opens as a picture with a Source switch, like Markdown. */
export function isSvg(path: string): boolean {
  return extension(path) === "svg";
}

/**
 * A data URL for the bytes. SVG goes through an `<img>` with this URL, never inlined as markup, so a script inside it
 * cannot run.
 */
export function imageDataUrl(path: string, base64: string): string {
  return `data:${imageType(path) ?? "application/octet-stream"};base64,${base64}`;
}

/** "357 bytes", "18 KB", "2.4 MB" (binary units, as the file limits). */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1 << 20) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1 << 20)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "120 × 80 px"; empty until the picture has loaded (an SVG without a size reports 0). */
export function pixelSizeLabel(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width} × ${height} px` : "";
}
