import { useCallback, useMemo, type ReactNode } from "react";
import { commentsCodec, formatComments, type CodeComment } from "../lib/comments";
import { fileKey } from "../lib/files";
import { PREFS, usePersistentState } from "../lib/storage";
import { useLatest } from "../lib/hooks";
import { useApp } from "./app";
import { useCode } from "./code";
import { useProject } from "./project";
import { createRequiredContext } from "../lib/context";

type CommentsValue = {
  /** Pending comments of this project, oldest first. */
  comments: CodeComment[];
  forFile(folder: string, path: string): CodeComment[];
  /** Pending comment count per file key. */
  counts: Map<string, number>;
  add(input: Omit<CodeComment, "id" | "created">): string;
  edit(id: string, text: string): void;
  /** Lines moved by edits in the editor (decoration tracking). */
  move(id: string, start: number, end: number): void;
  remove(id: string): void;
  removeAll(): void;
  /** Opens the file at the comment's lines. */
  reveal(comment: CodeComment): void;
  /**
   * The `octo-comments` block for every pending comment, quoting the lines as they are now
   * (open buffers first, else the file on disk). `commit()` removes exactly those comments.
   */
  prepare(): Promise<{ block: string; commit(): void } | null>;
};

export const {
  Provider: CommentsContextProvider,
  useRequired: useComments,
  useOptional: useOptionalComments,
} = createRequiredContext<CommentsValue>("useComments");

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Pending code comments of one project (spec §5): created in the editor, listed in the composer,
 * sent with the next message. Persisted in `localStorage["octo.comments.{projectId}"]`.
 */
export function CommentsProvider({ children }: { children: ReactNode }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const code = useCode();
  const [comments, setComments] = usePersistentState(PREFS.comments(projectId), commentsCodec);
  const ref = useLatest(comments);

  const { buffers, openFile } = code;

  const prepare = useCallback(async () => {
    const pending = ref.current;
    if (!pending.length) return null;
    const texts = new Map<string, string | null>();
    for (const c of pending) {
      const key = fileKey(c.folder, c.path);
      if (texts.has(key)) continue;
      const open = buffers.value(key);
      if (open !== null) texts.set(key, open);
      else
        texts.set(
          key,
          await bridge.readFile(projectId, c.folder, c.path).then(
            (f) => f.content,
            () => null,
          ),
        );
    }
    const block = formatComments(
      pending.map((c) => {
        const text = texts.get(fileKey(c.folder, c.path));
        const lines = text === null || text === undefined ? [] : text.split("\n").slice(c.start - 1, c.end);
        return { ...c, lines };
      }),
    );
    const ids = new Set(pending.map((c) => c.id));
    return { block, commit: () => setComments((cs) => cs.filter((c) => !ids.has(c.id))) };
  }, [bridge, projectId, buffers, ref, setComments]);

  const value = useMemo<CommentsValue>(() => {
    const counts = new Map<string, number>();
    for (const c of comments) {
      const key = fileKey(c.folder, c.path);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      comments,
      counts,
      forFile: (folder, path) => comments.filter((c) => c.folder === folder && c.path === path),
      add: (input) => {
        const id = newId();
        setComments((cs) => [...cs, { ...input, text: input.text.trim(), id, created: Date.now() }]);
        return id;
      },
      edit: (id, text) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, text: text.trim() } : c))),
      move: (id, start, end) =>
        setComments((cs) => {
          const c = cs.find((x) => x.id === id);
          if (!c || (c.start === start && c.end === end)) return cs;
          return cs.map((x) => (x.id === id ? { ...x, start, end } : x));
        }),
      remove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
      removeAll: () => setComments([]),
      reveal: (c) => openFile(c.folder, c.path, { line: c.start, endLine: c.end }),
      prepare,
    };
  }, [comments, openFile, prepare, setComments]);

  return <CommentsContextProvider value={value}>{children}</CommentsContextProvider>;
}
