import { BridgeError, type FileContent, type FileEntry, type FileStat, type WriteFileInput } from "@octo/agent-client";
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
    entries.set(name, { name, path: prefix + name, type: dir ? "dir" : "file", size: dir ? 0 : size(file) });
  }
  return [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
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
