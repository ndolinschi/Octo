import {
  BridgeError,
  type FileBytes,
  type FileContent,
  type FileEntry,
  type FilePathResult,
  type FileSearchMatch,
  type FileSearchParams,
  type FileStat,
  type MkdirInput,
  type RenameFileInput,
  type WriteFileInput,
} from "@octo/agent-client";
import { emit, writeDemoFile, type DemoFile, type ProjectRecord } from "./store";

/** Same limit as the harness. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Seeds every attached folder that has not been seeded yet. Content is imported lazily
 * so the demo's sample files stay out of the initial bundle; files agents wrote before
 * seeding win over the seed.
 */
export async function ensureSeeded(rec: ProjectRecord): Promise<void> {
  const missing = rec.project.folders.filter((f) => !rec.seeded.has(f.label));
  if (!missing.length) return;
  const { seedFolder } = await import("./seedFiles");
  for (const f of missing) {
    if (rec.seeded.has(f.label)) continue;
    const tree = rec.files.get(f.label) ?? new Map<string, DemoFile>();
    for (const [path, file] of seedFolder(f.label, rec.project.created_at)) if (!tree.has(path)) tree.set(path, file);
    rec.files.set(f.label, tree);
    rec.seeded.add(f.label);
  }
}

function folderTree(rec: ProjectRecord, folder: string): Map<string, DemoFile> {
  const tree = rec.files.get(folder);
  if (!tree || !rec.project.folders.some((f) => f.label === folder)) throw new BridgeError(404, "not_found", "folder not found");
  return tree;
}

function folderDirs(rec: ProjectRecord, folder: string): Set<string> {
  rec.dirs ??= new Map();
  let set = rec.dirs.get(folder);
  if (!set) {
    set = new Set();
    rec.dirs.set(folder, set);
  }
  return set;
}

function cleanPath(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) throw new BridgeError(400, "invalid_request", "path escapes the folder");
  if (parts.some((p) => p.toLowerCase() === ".git")) throw new BridgeError(400, "invalid_request", "path inside .git is refused");
  return parts.join("/");
}

function size(file: DemoFile): number {
  return file.size ?? new TextEncoder().encode(file.content).length;
}

function isDir(tree: Map<string, DemoFile>, dirs: ReadonlySet<string> | undefined, path: string): boolean {
  if (!path) return true;
  if (dirs?.has(path)) return true;
  for (const d of dirs ?? []) if (d.startsWith(`${path}/`)) return true;
  for (const p of tree.keys()) if (p.startsWith(`${path}/`)) return true;
  return false;
}

export function listDemoFiles(rec: ProjectRecord, folder: string, rawPath: string): FileEntry[] {
  const tree = folderTree(rec, folder);
  const dirs = rec.dirs?.get(folder);
  const path = cleanPath(rawPath);
  if (tree.has(path)) throw new BridgeError(400, "invalid", "path is not a directory");
  if (!isDir(tree, dirs, path)) throw new BridgeError(404, "not_found", "path not found");
  const prefix = path ? `${path}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const [p, file] of tree) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const name = rest.split("/")[0];
    if (name === undefined || name === ".git" || entries.has(name)) continue;
    const dir = rest.includes("/");
    const chain = dir ? demoChain(tree, prefix + name) : [];
    entries.set(name, { name, path: prefix + name, type: dir ? "dir" : "file", size: dir ? 0 : size(file), ...(chain.length ? { chain } : {}) });
  }
  for (const d of dirs ?? []) {
    if (!d.startsWith(prefix)) continue;
    const rest = d.slice(prefix.length);
    const name = rest.split("/")[0];
    if (!name || name === ".git" || entries.has(name)) continue;
    entries.set(name, { name, path: prefix + name, type: "dir", size: 0 });
  }
  return [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/** The harness's `FileEntry.chain` (decision 98): the directories below `path` while each holds one entry, a directory. */
export function demoChain(tree: ReadonlyMap<string, unknown>, path: string): string[] {
  const out: string[] = [];
  for (let cur = path; out.length < 32;) {
    const kids = new Map<string, boolean>();
    for (const p of tree.keys()) {
      if (!p.startsWith(`${cur}/`)) continue;
      const rest = p.slice(cur.length + 1);
      const name = rest.split("/")[0] ?? "";
      if (name === ".git") continue;
      kids.set(name, (kids.get(name) ?? false) || rest.includes("/"));
      if (kids.size > 1) break;
    }
    const only = kids.size === 1 ? [...kids][0] : undefined;
    if (!only?.[1]) break;
    out.push(only[0]);
    cur = `${cur}/${only[0]}`;
  }
  return out;
}

function stat(folder: string, path: string, file: DemoFile): FileStat {
  return { folder, path, size: size(file), mtime: file.mtime };
}

export function readDemoFile(rec: ProjectRecord, folder: string, rawPath: string): FileContent {
  const tree = folderTree(rec, folder);
  const dirs = rec.dirs?.get(folder);
  const path = cleanPath(rawPath);
  const file = tree.get(path);
  if (!file) {
    if (isDir(tree, dirs, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
    throw new BridgeError(404, "not_found", "path not found");
  }
  if (size(file) > MAX_BYTES) throw new BridgeError(413, "file_too_large", "file exceeds the 2 MiB limit");
  if (file.binary) throw new BridgeError(415, "binary_file", "file is not text");
  return { ...stat(folder, path, file), content: file.content };
}

/** A 120×80 palette PNG (357 bytes): what every binary demo `.png` holds, so the image preview has something to show. */
const DEMO_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAMAAADlRUG7AAAADFBMVEUAAAA7bthYiujysTyocZmMAAAAAXRSTlMAQObYZgAAAQdJREFUeNrt2UEOwyAMRNEU3//O3aWqYhuC+11FmlmyyGMTGJnjUBRFKWeM15lx5udrDtziOnCPm8Gom8CsG8OwG8K0G8G4G8C868MNrgt3uMOBW9zhndUdbgazZ2cMw2d2CNN3RQTjd1QA83ejD69/zz65txcXXnbtO3f2XOpcZhe5pXPZNS2dyyyRwc5llshg5zJLZLJzZTDZuSwO27kSmO1cKzDSuRZgpnPNYahzTWGqc81grHNNYK5z5TDYuVKY7FwZzHauorvfudLbCe1cNbfSuUruIzuX8zO3zbn23fKc6/5/pDmX5lyac2nOpTmX5lz0nGt7rTbnKqzpbfGPb4uKojw1bxvAKY84J7D8AAAAAElFTkSuQmCC";

/** The file API's `?encoding=base64` read: any file, same limits; binary `.png` files are {@link DEMO_PNG}. */
export function readDemoFileBytes(rec: ProjectRecord, folder: string, rawPath: string): FileBytes {
  const tree = folderTree(rec, folder);
  const dirs = rec.dirs?.get(folder);
  const path = cleanPath(rawPath);
  const file = tree.get(path);
  if (!file) {
    if (isDir(tree, dirs, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
    throw new BridgeError(404, "not_found", "path not found");
  }
  if (size(file) > MAX_BYTES) throw new BridgeError(413, "file_too_large", "file exceeds the 2 MiB limit");
  if (file.binary) {
    const content = path.toLowerCase().endsWith(".png") ? DEMO_PNG : "";
    return { folder, path, size: atob(content).length, mtime: file.mtime, content, encoding: "base64" };
  }
  const bytes = new TextEncoder().encode(file.content);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { ...stat(folder, path, file), content: btoa(bin), encoding: "base64" };
}

export function writeDemo(rec: ProjectRecord, input: WriteFileInput): FileStat {
  const tree = folderTree(rec, input.folder);
  const dirs = rec.dirs?.get(input.folder);
  const path = cleanPath(input.path);
  if (!path || isDir(tree, dirs, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
  const current = tree.get(path);
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!current && !isDir(tree, dirs, parent)) throw new BridgeError(404, "not_found", "parent directory not found");
  if (input.expected_mtime !== undefined && current && current.mtime !== input.expected_mtime) {
    throw new BridgeError(409, "file_changed", "file changed on disk");
  }
  const file = writeDemoFile(rec, input.folder, path, input.content, "user");
  return stat(input.folder, path, file);
}

export function mkdirDemo(rec: ProjectRecord, input: MkdirInput): FilePathResult {
  const tree = folderTree(rec, input.folder);
  const dirs = folderDirs(rec, input.folder);
  const path = cleanPath(input.path);
  if (!path) throw new BridgeError(400, "invalid_request", "path is required");
  if (tree.has(path) || isDir(tree, dirs, path)) {
    throw new BridgeError(409, "already_exists", "A file or folder already exists at that path.");
  }
  dirs.add(path);
  emit(rec, { type: "file.changed", folder: input.folder, path, source: "user" });
  return { folder: input.folder, path };
}

export function renameDemo(rec: ProjectRecord, input: RenameFileInput): FilePathResult {
  const tree = folderTree(rec, input.folder);
  const dirs = folderDirs(rec, input.folder);
  const from = cleanPath(input.from);
  const to = cleanPath(input.to);
  if (!from || !to) throw new BridgeError(400, "invalid_request", "from and to paths are required");
  const srcIsFile = tree.has(from);
  const srcIsDir = !srcIsFile && isDir(tree, dirs, from);
  if (!srcIsFile && !srcIsDir) throw new BridgeError(404, "not_found", "path not found");
  if (tree.has(to) || isDir(tree, dirs, to)) {
    throw new BridgeError(409, "already_exists", "A file or folder already exists at that path.");
  }
  if (srcIsFile) {
    const file = tree.get(from)!;
    tree.delete(from);
    tree.set(to, file);
  } else {
    const prefix = `${from}/`;
    for (const [p, file] of [...tree.entries()]) {
      if (p.startsWith(prefix)) {
        tree.delete(p);
        tree.set(`${to}/${p.slice(prefix.length)}`, file);
      }
    }
    for (const d of [...dirs]) {
      if (d === from) {
        dirs.delete(d);
        dirs.add(to);
      } else if (d.startsWith(prefix)) {
        dirs.delete(d);
        dirs.add(`${to}/${d.slice(prefix.length)}`);
      }
    }
    dirs.add(to);
  }
  emit(rec, { type: "file.changed", folder: input.folder, path: to, source: "user" });
  return { folder: input.folder, path: to };
}

export function deleteDemo(rec: ProjectRecord, folder: string, rawPath: string): void {
  const tree = folderTree(rec, folder);
  const dirs = rec.dirs?.get(folder);
  const path = cleanPath(rawPath);
  if (!path) throw new BridgeError(400, "invalid_request", "cannot delete folder root");
  const hadFile = tree.delete(path);
  let removed = hadFile;
  const prefix = `${path}/`;
  for (const p of [...tree.keys()]) {
    if (p.startsWith(prefix)) {
      tree.delete(p);
      removed = true;
    }
  }
  if (dirs) {
    for (const d of [...dirs]) {
      if (d === path || d.startsWith(prefix)) {
        dirs.delete(d);
        removed = true;
      }
    }
  }
  if (!removed) throw new BridgeError(404, "not_found", "path not found");
  emit(rec, { type: "file.changed", folder, path, source: "user" });
}

function subseqMatch(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

export function searchDemoFiles(rec: ProjectRecord, params: FileSearchParams): FileSearchMatch[] {
  const mode = params.mode ?? "name";
  const limit = Math.max(1, Math.min(200, params.limit ?? 50));
  const q = params.q.trim().toLowerCase();
  const out: FileSearchMatch[] = [];
  if (mode === "content") {
    if (!q) return out;
    for (const f of rec.project.folders) {
      const tree = rec.files.get(f.label);
      if (!tree) continue;
      for (const [path, file] of [...tree.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (file.binary || size(file) > MAX_BYTES) continue;
        const lines = file.content.split("\n");
        for (let idx = 0; idx < lines.length; idx += 1) {
          const line = lines[idx] ?? "";
          if (line.toLowerCase().includes(q)) {
            const trimmed = line.trim();
            out.push({ folder: f.label, path, line: idx + 1, preview: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    return out;
  }
  const scored: { score: number; match: FileSearchMatch }[] = [];
  for (const f of rec.project.folders) {
    const tree = rec.files.get(f.label);
    if (!tree) continue;
    for (const path of tree.keys()) {
      if (!q) {
        scored.push({ score: 0, match: { folder: f.label, path } });
        continue;
      }
      const lp = path.toLowerCase();
      const base = lp.slice(lp.lastIndexOf("/") + 1);
      let score = -1;
      if (base === q) score = 0;
      else if (base.startsWith(q)) score = 1;
      else if (base.includes(q)) score = 2;
      else if (lp.includes(q)) score = 3;
      else if (subseqMatch(q, lp)) score = 4;
      if (score >= 0) scored.push({ score, match: { folder: f.label, path } });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.match.path.localeCompare(b.match.path));
  return scored.slice(0, limit).map((s) => s.match);
}
