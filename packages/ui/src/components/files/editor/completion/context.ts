/**
 * What an inline-completion request may carry (inline completion design, decisions 2, 5 and 6). Pure: no Monaco, no React.
 */

/** Characters before the cursor sent at most (decision 2); cut on a line boundary. */
export const PREFIX_MAX = 6000;
/** Characters after the cursor sent at most (decision 2); cut on a line boundary. */
export const SUFFIX_MAX = 2000;
/** Files over this size are never sent (decision 6). */
export const FILE_MAX = 1_000_000;

/**
 * The last `max` characters of the text before the cursor, starting at a line start: a prefix that would begin in the
 * middle of a line drops that partial line. The cursor's own line is always kept whole (it is the part that matters),
 * even when it alone is longer than `max`.
 */
export function cutPrefix(prefix: string, max = PREFIX_MAX): string {
  if (prefix.length <= max) return prefix;
  const lineStart = prefix.lastIndexOf("\n") + 1;
  if (prefix.length - lineStart >= max) return prefix.slice(lineStart);
  const from = prefix.length - max;
  // `from - 1` is a newline: the window already starts on a line.
  if (prefix[from - 1] === "\n") return prefix.slice(from);
  const nl = prefix.indexOf("\n", from);
  return nl < 0 ? prefix.slice(lineStart) : prefix.slice(nl + 1);
}

/** The first `max` characters after the cursor, ending at a line end; the rest of the cursor's line is always kept. */
export function cutSuffix(suffix: string, max = SUFFIX_MAX): string {
  if (suffix.length <= max) return suffix;
  const lineEnd = suffix.indexOf("\n");
  if (lineEnd < 0 || lineEnd >= max) return lineEnd < 0 ? suffix : suffix.slice(0, lineEnd);
  if (suffix[max] === "\n") return suffix.slice(0, max);
  const nl = suffix.lastIndexOf("\n", max);
  return suffix.slice(0, nl);
}

const SECRET_NAMES = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_[^/]*$/i, /\.p12$/i, /\.pfx$/i];

/**
 * Files that look like they hold secrets (decision 6): `.env*`, `*.pem`, `*.key`, `id_*` (SSH keys), certificate
 * bundles, and anything under a `.git/` directory. Matched on the path relative to the folder, `/`-separated.
 */
export function isSecretPath(path: string): boolean {
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.slice(0, -1).includes(".git")) return true;
  const name = parts[parts.length - 1] ?? "";
  return SECRET_NAMES.some((re) => re.test(name));
}

const NUL = String.fromCharCode(0);

/** A NUL character in the first 8 kB is how editors (and git) tell a binary file from text. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes(NUL);
}

/** Why a file is never sent (shown as "off" on the status item), or null when it may be. */
export function fileExclusion(file: { path: string; size: number; sample: string; readOnly: boolean }): string | null {
  if (isSecretPath(file.path)) return "Not used in files that may hold secrets";
  if (file.size > FILE_MAX) return "Not used in files over 1 MB";
  if (looksBinary(file.sample)) return "Not used in binary files";
  if (file.readOnly) return "Not used in read-only files";
  return null;
}

/** The moments a request is not made at all (decision 5); none of them changes the status item. */
export type Moment = { selection: boolean; composing: boolean; suggestListOpen: boolean };

export function skipNow(m: Moment): boolean {
  return m.selection || m.composing || m.suggestListOpen;
}
