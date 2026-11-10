/** Stable id for a file or directory inside a project folder. Built only by `fileKey` / `parseFileKey`. */
export type FileKey = string & { readonly __brand: "FileKey" };

// The one place that knows the separator (NUL cannot occur in a folder label or a path).
const SEP = "\u0000";

/** The key of `path` inside `folder`; `path` "" is the folder root. */
export function fileKey(folder: string, path: string): FileKey {
  // The brand is applied here: the string was just built from its two parts.
  return `${folder}${SEP}${path}` as FileKey;
}

/** The key for a raw string (a stored tab id, a DOM attribute), or null when it is not a file key. */
export function parseFileKey(raw: string): FileKey | null {
  return raw.includes(SEP) ? (raw as FileKey) : null;
}

export function splitKey(key: FileKey): { folder: string; path: string } {
  const i = key.indexOf(SEP);
  return { folder: key.slice(0, i), path: key.slice(i + 1) };
}

/** The folder a key belongs to. */
export function keyFolder(key: FileKey): string {
  return splitKey(key).folder;
}

/** Whether `key` is a folder root (path ""), the only keys that expand by default. */
export function isRootKey(key: string): boolean {
  return key.endsWith(SEP);
}

/** Whether `key` lies inside `folder` (the folder root included). */
export function keyInFolder(key: string, folder: string): boolean {
  return key.startsWith(`${folder}${SEP}`);
}

/** Folder-relative, slash-separated, no leading "./" or trailing "/"; "." becomes "". */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** "" plus every ancestor directory of `path`, outermost first (excludes `path` itself). */
export function ancestors(path: string): string[] {
  const out = [""];
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return path ? out : [];
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** Agent file tools default to the project's first folder when `folder` is omitted. */
export function resolveFolder(folders: { label: string }[], folder: string | undefined): string | null {
  if (folder) return folders.some((f) => f.label === folder) ? folder : null;
  return folders[0]?.label ?? null;
}

/** Where to put the cursor when opening a file: 1-based lines (a range when `endLine` is given). */
export type FilePosition = { line: number; column?: number; endLine?: number };
