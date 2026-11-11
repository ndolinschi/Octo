import { useOptionalComments } from "../../state/comments";
import { useOptionalCode } from "../../state/code";
import { ChangesTab } from "../v7/ChangesTab";

const loadMonaco = () => import("../files/monaco");

/** The Changes tab with what only the dock can do: open a file in the editor, send a line comment to the composer. */
export function ChangesPane() {
  const code = useOptionalCode();
  const comments = useOptionalComments();
  return (
    <ChangesTab
      loadMonaco={loadMonaco}
      {...(code ? { onOpenFile: (folder: string, path: string) => code.openFile(folder, path) } : {})}
      {...(comments
        ? {
            onAddComment: (c: { folder: string; path: string; start: number; end: number; text: string }) => void comments.add(c),
            commentsFor: (folder: string, path: string) => comments.forFile(folder, path),
          }
        : {})}
    />
  );
}
