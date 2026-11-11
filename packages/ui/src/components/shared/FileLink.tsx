import { useEffect, type ReactNode } from "react";
import { fileLookup, looksLikePath, resolveFileRef } from "../../lib/fileLinks";
import { useOptionalCode } from "../../state/code";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";

/**
 * Inline code in assistant prose that names a project file becomes a link to it (decision 19): the file
 * glyph inside the same mono chip, `link` colour on hover only; `path:12` / `path:12-20` selects the lines.
 * Resolution uses the file index of Filter files, loaded lazily (the first path-like code asks for it) and
 * never blocking: until it is in, or when nothing matches, the code stays plain.
 */
export function InlineCode({ children }: { children?: ReactNode }) {
  const code = useOptionalCode();
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const candidate = text !== null && looksLikePath(text);
  const status = code?.fileIndex.status;
  const indexFiles = code?.indexFiles;
  useEffect(() => {
    if (candidate && status === "idle") indexFiles?.();
  }, [candidate, status, indexFiles]);
  const ref = candidate && code && text ? resolveFileRef(text, fileLookup(code.loadedFiles)) : null;
  if (!ref || !code) return <code>{children}</code>;
  const where = ref.start ? (ref.end ? `, lines ${ref.start}–${ref.end}` : `, line ${ref.start}`) : "";
  return (
    <button
      type="button"
      data-file-link
      className="octo-file-link"
      title={`Open ${ref.folder}/${ref.path}${where}`}
      onClick={() => code.openFile(ref.folder, ref.path, ref.start ? { line: ref.start, ...(ref.end ? { endLine: ref.end } : {}) } : undefined)}
    >
      <code>
        <Glyph icon={fileIcon(ref.path)} size={14} />
        {text}
      </code>
    </button>
  );
}
