import { memo, useEffect, type ReactNode } from "react";
import { fileLookup, looksLikePath, resolveFileRef, type FileRef } from "../../lib/fileLinks";
import { useOptionalCode } from "../../state/code";
import { useOptionalProject } from "../../state/project";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { InlineButton } from "../primitives/InlineButton";

type FlatFile = { folder: string; path: string };
const keptFlatCache = new WeakMap<Map<string, readonly string[]>, { size: number; files: FlatFile[] }>();

function cachedKeptFiles(map: Map<string, readonly string[]>): FlatFile[] {
  const hit = keptFlatCache.get(map);
  if (hit && hit.size === map.size) return hit.files;
  const files: FlatFile[] = [];
  for (const [folder, paths] of map) {
    for (const path of paths) files.push({ folder, path });
  }
  keptFlatCache.set(map, { size: map.size, files });
  return files;
}

/**
 * Resolves a path-like string against the project's lazily loaded file index (decision 19).
 * Returns its resolved target, tooltip, and opener, or null until the index loads / when nothing matches.
 */
export function useFileRef(text: string | null): { ref: FileRef; title: string; open(): void } | null {
  const code = useOptionalCode();
  const candidate = text !== null && looksLikePath(text);
  const status = code?.fileIndex.status;
  const indexFiles = code?.indexFiles;
  useEffect(() => {
    if (candidate && status === "idle") indexFiles?.();
  }, [candidate, status, indexFiles]);
  // Decision 99: until this view's walk is done, the files as last walked (a project shown again, or read before it was shown),
  // so a link is a link in the first frame; `CodeProvider` keeps `kept.files` updated once per completed walk.
  const kept = useOptionalProject()?.kept;
  const done = status === "done";
  const loaded = code?.loadedFiles;
  const files = !done && kept?.files.size ? cachedKeptFiles(kept.files) : loaded;
  const ref = candidate && code && text && files ? resolveFileRef(text, fileLookup(files)) : null;
  if (!ref || !code) return null;
  const where = ref.start ? (ref.end ? `, lines ${ref.start}–${ref.end}` : `, line ${ref.start}`) : "";
  return {
    ref,
    title: `Open ${ref.folder}/${ref.path}${where}`,
    open: () => code.openFile(ref.folder, ref.path, ref.start ? { line: ref.start, ...(ref.end ? { endLine: ref.end } : {}) } : undefined),
  };
}

/**
 * Inline code in assistant prose that names a project file becomes a link to it (decision 19): the file
 * glyph inside the same mono chip, `link` colour on hover only; `path:12` / `path:12-20` selects the lines.
 * Resolution uses the file index of Filter files, loaded lazily (the first path-like code asks for it) and
 * never blocking: until it is in, or when nothing matches, the code stays plain.
 */
export const InlineCode = memo(function InlineCode({ children }: { children?: ReactNode }) {
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const hit = useFileRef(text);
  if (!hit) return <code>{children}</code>;
  return (
    // Inline, not a <button>: an atomic inline never breaks and pulled the "(" before it onto the chip's line.
    <InlineButton data-file-link="" data-warm="tool:files" className="octo-file-link" title={hit.title} onPress={hit.open}>
      <code>
        <Glyph icon={fileIcon(hit.ref.path)} size={14} />
        {text}
      </code>
    </InlineButton>
  );
});
