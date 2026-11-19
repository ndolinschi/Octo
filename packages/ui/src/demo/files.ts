import { BridgeError, type FileBytes, type FileContent, type FileEntry, type FileStat, type WriteFileInput } from "@octo/agent-client";
import { writeDemoFile, type DemoFile, type ProjectRecord } from "./store";

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

function cleanPath(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) throw new BridgeError(400, "invalid", "path escapes the folder");
  return parts.join("/");
}

function size(file: DemoFile): number {
  return file.size ?? new TextEncoder().encode(file.content).length;
}

function isDir(tree: Map<string, DemoFile>, path: string): boolean {
  if (!path) return true;
  for (const p of tree.keys()) if (p.startsWith(`${path}/`)) return true;
  return false;
}

export function listDemoFiles(rec: ProjectRecord, folder: string, rawPath: string): FileEntry[] {
  const tree = folderTree(rec, folder);
  const path = cleanPath(rawPath);
  if (tree.has(path)) throw new BridgeError(400, "invalid", "path is not a directory");
  if (!isDir(tree, path)) throw new BridgeError(404, "not_found", "path not found");
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
  const path = cleanPath(rawPath);
  const file = tree.get(path);
  if (!file) {
    if (isDir(tree, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
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
  const path = cleanPath(rawPath);
  const file = tree.get(path);
  if (!file) {
    if (isDir(tree, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
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
  const path = cleanPath(input.path);
  if (!path || isDir(tree, path)) throw new BridgeError(400, "invalid", "path is not a regular file");
  const current = tree.get(path);
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!current && !isDir(tree, parent)) throw new BridgeError(404, "not_found", "parent directory not found");
  if (input.expected_mtime !== undefined && current && current.mtime !== input.expected_mtime) {
    throw new BridgeError(409, "file_changed", "file changed on disk");
  }
  const file = writeDemoFile(rec, input.folder, path, input.content, "user");
  return stat(input.folder, path, file);
}
