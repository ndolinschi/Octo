import { File, FileCode, FileBraces, FileImage, FileText, Folder, FolderOpen, type LucideIcon } from "lucide-react";

/** Extension (lower case, no dot) → icon. One neutral tone for all of them (`fg-3`): no per-language colours. */
const BY_EXT: Record<string, LucideIcon> = {};
const add = (icon: LucideIcon, exts: string) => exts.split(" ").forEach((e) => (BY_EXT[e] = icon));
/* Five file glyphs only (contract v6 decision 14): code (stylesheets and markup included), config (JSON too: one braces glyph),
   text/Markdown, image, and the generic file. */
add(FileCode, "ts tsx js jsx mjs cjs go rs py rb java kt swift c h cc cpp hpp cs php sh bash zsh sql html vue svelte astro css scss sass less");
add(FileBraces, "json jsonc json5 ndjson toml yaml yml ini lock env conf cfg properties mod sum gradle pro");
add(FileText, "md markdown mdx txt rst");
add(FileImage, "png jpg jpeg gif webp svg ico avif bmp");

/** Dotfiles and names without an extension that are configuration. */
const BY_NAME: Record<string, LucideIcon> = {
  ".gitignore": FileBraces,
  ".env": FileBraces,
  ".env.example": FileBraces,
  Podfile: FileBraces,
  Dockerfile: FileBraces,
  Makefile: FileBraces,
};

/** The icon for a file name (by extension), used in the tree, file tabs and crumbs. */
export function fileIcon(name: string): LucideIcon {
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return File;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? File;
}

export function folderIcon(open: boolean): LucideIcon {
  return open ? FolderOpen : Folder;
}

/** Markdown files open in Preview. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
