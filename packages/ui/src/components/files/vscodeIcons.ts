import iconSet from "@iconify-json/vscode-icons/icons.json";
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js";

type IconData = { body: string; width?: number; height?: number };
const ICONS = iconSet.icons as Record<string, IconData | undefined>;
const DEFAULT_SIZE = iconSet.width;
const DEFAULT_FILE_KEY = "default-file";
const DEFAULT_FOLDER_KEY = "default-folder";
const DEFAULT_FOLDER_OPEN_KEY = "default-folder-opened";

const svgCache = new Map<string, string>();

function toKey(svgName: string | undefined, fallback: string): string {
  if (!svgName) return fallback;
  const key = svgName.replace(/\.svg$/, "").replace(/_/g, "-");
  return ICONS[key] ? key : fallback;
}

/**
 * Encodes an Iconify SVG icon into an isolated `data:image/svg+xml` URL (cached per icon key).
 * Using `<img>` avoids duplicate `<linearGradient id="...">` collisions across icons in the DOM.
 */
function svgUrl(key: string, fallback: string): string {
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  const data = ICONS[key] ?? ICONS[fallback];
  if (!data) return "";
  const w = data.width ?? DEFAULT_SIZE;
  const h = data.height ?? DEFAULT_SIZE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${data.body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  svgCache.set(key, url);
  return url;
}

/** Returns a cached `data:image/svg+xml` URL for a file's vscode-icons glyph. */
export function vscodeFileIcon(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  let raw = getIconForFile(base);
  if (!raw || raw === "default_file.svg") {
    const lower = base.toLowerCase();
    if (lower !== base) raw = getIconForFile(lower);
  }
  const key = toKey(raw, DEFAULT_FILE_KEY);
  return svgUrl(key, DEFAULT_FILE_KEY);
}

/** Returns a cached `data:image/svg+xml` URL for a folder's vscode-icons glyph (open or closed). */
export function vscodeFolderIcon(name: string, expanded: boolean): string {
  const lookup = expanded ? getIconForOpenFolder : getIconForFolder;
  const defaultSvg = expanded ? "default_folder_opened.svg" : "default_folder.svg";
  const fallbackKey = expanded ? DEFAULT_FOLDER_OPEN_KEY : DEFAULT_FOLDER_KEY;
  // Compact folders ("frontend/tmp" or "assets/images"): try the last segment first, then the first segment.
  const parts = name.split("/").filter(Boolean);
  const lastPart = parts[parts.length - 1];
  const firstPart = parts[0];
  const candidates = parts.length > 1 && lastPart && firstPart ? [lastPart, firstPart] : [name];
  let chosen: string | undefined;
  for (const part of candidates) {
    let raw = lookup(part);
    if (!raw || raw === defaultSvg) {
      const lower = part.toLowerCase();
      if (lower !== part) raw = lookup(lower);
    }
    if (raw && raw !== defaultSvg) {
      chosen = raw;
      break;
    }
  }
  const key = toKey(chosen, fallbackKey);
  return svgUrl(key, fallbackKey);
}

export type VscodeIconsApi = {
  fileIcon(name: string): string;
  folderIcon(name: string, expanded: boolean): string;
};

export const vscodeIconsApi: VscodeIconsApi = {
  fileIcon: vscodeFileIcon,
  folderIcon: vscodeFolderIcon,
};
