/** Stable id for a file or directory inside a project folder. `path` "" is the folder root. */
export function fileKey(folder: string, path: string): string {
  return `${folder}\u0000${path}`;
}

export function splitKey(key: string): { folder: string; path: string } {
  const i = key.indexOf("\u0000");
  return { folder: key.slice(0, i), path: key.slice(i + 1) };
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
