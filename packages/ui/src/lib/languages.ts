/** Language ids (as language servers declare them) by file extension: enough to tell which servers a project can use. */
const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  py: "python",
  pyi: "python",
  rs: "rust",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  toml: "toml",
  md: "markdown",
  css: "css",
  html: "html",
  sh: "shellscript",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
};

export function languageOfPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The languages present among `paths`. */
export function languagesIn(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const l = languageOfPath(p);
    if (l) out.add(l);
  }
  return out;
}
