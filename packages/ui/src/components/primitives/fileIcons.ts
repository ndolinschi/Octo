import { AlignLeft, Braces, CodeXml, File, Image, type LucideIcon } from "lucide-react";

/** Extension (lower case, no dot) → icon. One neutral tone for all of them (`fg-3`): no per-language colours. */
// A Map, not an object: "constructor" or "toString" as an extension must not find Object.prototype members.
const BY_EXT = new Map<string, LucideIcon>();
const add = (icon: LucideIcon, exts: string) => exts.split(" ").forEach((e) => BY_EXT.set(e, icon));
/* Five file glyphs only (contract v6 decision 14, re-cut in v6.1): badge-free shapes that stay legible at 14px —
   code `</>` (stylesheets and markup included), config `{}` (JSON too), text/Markdown (lines), image, and the
   generic page for everything else. No page-with-badge glyphs: their inner mark clots at this size. */
add(CodeXml, "ts tsx js jsx mjs cjs go rs py rb java kt swift c h cc cpp hpp cs php sh bash zsh sql html vue svelte astro css scss sass less");
add(Braces, "json jsonc json5 ndjson toml yaml yml ini lock env conf cfg properties mod sum gradle pro");
add(AlignLeft, "md markdown mdx txt rst");
add(Image, "png jpg jpeg gif webp svg ico avif bmp");

/** Dotfiles and names without an extension that are configuration. */
const BY_NAME = new Map<string, LucideIcon>([".gitignore", ".env", ".env.example", "Podfile", "Dockerfile", "Makefile"].map((name) => [name, Braces]));

/** The icon for a file name (by extension), used in the tree, file tabs and crumbs. */
export function fileIcon(name: string): LucideIcon {
  const byName = BY_NAME.get(name);
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return File;
  return BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? File;
}

/** Markdown files open in Preview. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
