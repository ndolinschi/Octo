/**
 * A file dropped or pasted onto the composer (decision 62), read as text and sent inside the message. What may be attached
 * (`refusal`) and the pill's size label are in `attachmentRules`, loaded on the first drop or paste (this module is in the entry chunk).
 */
export type Attachment = { id: string; name: string; size: number; text: string };

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
