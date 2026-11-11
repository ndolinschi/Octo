/**
 * `file:` URIs for files in a project's folders, and back. Folder paths are absolute (POSIX or
 * Windows); each path segment is percent-encoded the way VS Code and most servers expect.
 */

function segments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

const DRIVE = /^[A-Za-z]:$/;

function encodeSegment(s: string, first: boolean): string {
  // A Windows drive ("C:") stays readable; everything else is encoded.
  return first && DRIVE.test(s) ? s : encodeURIComponent(s);
}

/** `file:///abs/folder/rel/path` for a folder's absolute path and a folder-relative path. */
export function fileUri(folderPath: string, relPath = ""): string {
  const parts = [...segments(folderPath), ...segments(relPath)];
  return `file:///${parts.map((s, i) => encodeSegment(s, i === 0)).join("/")}`;
}

function decodedSegments(uri: string): string[] | null {
  if (!uri.startsWith("file://")) return null;
  // Skip an authority ("file://host/…" is not ours; "file:///" has none).
  const rest = uri.slice("file://".length);
  if (!rest.startsWith("/")) return null;
  try {
    return segments(rest.split(/[?#]/, 1)[0] ?? rest).map(decodeURIComponent);
  } catch {
    return null;
  }
}

const norm = (s: string, first: boolean) => (first && DRIVE.test(s) ? s.toUpperCase() : s);

/** The project folder (label) and folder-relative path a `file:` URI points into, or null if outside. */
export function fromFileUri(uri: string, folders: { label: string; path: string }[]): { folder: string; path: string } | null {
  const target = decodedSegments(uri);
  if (!target) return null;
  let best: { folder: string; path: string; depth: number } | null = null;
  for (const f of folders) {
    const base = segments(f.path);
    if (
      base.length > target.length ||
      !base.every((s, i) => {
        const t = target[i];
        return t !== undefined && norm(s, i === 0) === norm(t, i === 0);
      })
    )
      continue;
    if (!best || base.length > best.depth) best = { folder: f.label, path: target.slice(base.length).join("/"), depth: base.length };
  }
  return best && best.path ? { folder: best.folder, path: best.path } : null;
}
