/** A file reference in prose: `folder/path`, or a path unique under one folder, optionally `:12` or `:12-20`. */
export type FileRef = { folder: string; path: string; start?: number; end?: number };

const REF = /^([^\s:`'"<>|*?]+?)(?::(\d+)(?:-(\d+))?)?$/;

/** Whether inline code could be a file path at all (worth loading the file index for). */
export function looksLikePath(text: string): boolean {
  const m = REF.exec(text.trim());
  const p = m?.[1] ?? "";
  return p.length > 2 && /[/.]/.test(p) && !p.startsWith("http") && /\.[A-Za-z0-9]+$|\//.test(p) && !/^\.+$/.test(p);
}

export type FileLookup = { byFolder: Map<string, Set<string>>; byPath: Map<string, string[]> };

const lookups = new WeakMap<object, FileLookup>();

/** Indexes the loaded files (cached per list, so every inline code of a transcript shares one index). */
export function fileLookup(files: readonly { folder: string; path: string }[]): FileLookup {
  const hit = lookups.get(files);
  if (hit) return hit;
  const byFolder = new Map<string, Set<string>>();
  const byPath = new Map<string, string[]>();
  for (const f of files) {
    let set = byFolder.get(f.folder);
    if (!set) byFolder.set(f.folder, (set = new Set()));
    set.add(f.path);
    const folders = byPath.get(f.path);
    if (folders) folders.push(f.folder);
    else byPath.set(f.path, [f.folder]);
  }
  const lookup = { byFolder, byPath };
  lookups.set(files, lookup);
  return lookup;
}

/** Resolves inline code to a project file, or null (unresolved code stays plain). */
export function resolveFileRef(text: string, lookup: FileLookup): FileRef | null {
  const m = REF.exec(text.trim());
  if (!m?.[1]) return null;
  const raw = m[1].replace(/^\.\//, "");
  const start = m[2] ? Number(m[2]) : undefined;
  const end = m[3] ? Number(m[3]) : undefined;
  const lines = start ? { start, ...(end && end >= start ? { end } : {}) } : {};
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const folder = raw.slice(0, slash);
    const rest = raw.slice(slash + 1);
    if (lookup.byFolder.get(folder)?.has(rest)) return { folder, path: rest, ...lines };
  }
  const folders = lookup.byPath.get(raw);
  if (folders && folders.length === 1 && folders[0] !== undefined) return { folder: folders[0], path: raw, ...lines };
  return null;
}
