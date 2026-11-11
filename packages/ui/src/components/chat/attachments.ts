/** A file dropped or pasted onto the composer (decision 62), read as text and sent inside the message. */
export type Attachment = { id: string; name: string; size: number; text: string };

/** Larger files are refused: the whole text goes into the message. */
export const ATTACH_MAX_BYTES = 256 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env\.example|csv|tsv|log|xml|html?|css|scss|less|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|dart|ex|exs|erl|hs|ml|scala|r|tf|hcl|gradle|dockerfile|makefile|gitignore)$/i;

/** Whether a file can be attached as text, judged by its type or name (a browser leaves `type` empty for many). */
export function isTextFile(name: string, type: string): boolean {
  if (type.startsWith("text/") || /json|xml|yaml|javascript|typescript|x-sh|sql|toml/.test(type)) return true;
  return TEXT_EXT.test(name) || /^(dockerfile|makefile|readme|license)$/i.test(name);
}

const FENCE_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  css: "css",
  html: "html",
  sql: "sql",
};

/** The message text with each attachment appended as a fenced block under its name (fences longer than any inside). */
export function withAttachments(text: string, files: readonly Attachment[]): string {
  if (!files.length) return text;
  const blocks = files.map((f) => {
    const ext = f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase();
    const longest = Math.max(2, ...[...f.text.matchAll(/`{3,}/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    return `Attached file \`${f.name}\`:\n\n${fence}${FENCE_LANG[ext] ?? ""}\n${f.text.replace(/\n$/, "")}\n${fence}`;
  });
  return [text, ...blocks].filter(Boolean).join("\n\n");
}

/** Why a file was not attached, as said under the composer; null when it can be. */
export function refusal(name: string, type: string, size: number): string | null {
  if (type.startsWith("image/")) return `${name} is an image. Images can't be sent yet: the harness takes text only.`;
  if (!isTextFile(name, type)) return `${name} isn't a text file, so it can't be attached.`;
  if (size > ATTACH_MAX_BYTES) return `${name} is larger than 256 KB. Attach a smaller file or mention its path with @.`;
  return null;
}

/** "812 B", "4 KB", "1.2 MB" for a pill. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
