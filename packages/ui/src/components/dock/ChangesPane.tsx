import { useEffect, useRef, useSyncExternalStore } from "react";
import { changesFocus, clearChangesFocus, subscribeChangesFocus } from "../../lib/changesFocus";
import { useLatest } from "../../lib/hooks";
import { useOptionalComments } from "../../state/comments";
import { useOptionalCode } from "../../state/code";
import { Panel } from "../primitives/Panel";
import { ChangesTab } from "../v7/ChangesTab";

const loadMonaco = () => import("../files/monaco");

/** The Changes tab with what only the dock can do: open a file in the editor, send a line comment to the composer, show the request the conversation asked for. */
export function ChangesPane() {
  const code = useOptionalCode();
  const comments = useOptionalComments();
  const focus = useSyncExternalStore(subscribeChangesFocus, changesFocus);
  const mark = useRef<HTMLSpanElement>(null);
  const latest = useLatest(focus);
  // Tabs stay mounted while hidden. The chat sets a focus and then opens the tab, so the pane shows with a newer focus;
  // any other way of showing it (palette, status bar) finds the one it left behind and drops it.
  useEffect(() => {
    const el = mark.current;
    if (!el) return;
    let leftWith: number | null | undefined;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      const now = latest.current;
      if (!visible) leftWith = now?.seq ?? null;
      else if (leftWith !== undefined && now?.seq === leftWith) clearChangesFocus();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [latest]);
  return (
    <Panel name="changes" title="Changes">
      <span ref={mark} aria-hidden className="block h-0 w-0" />
      <ChangesTab
        loadMonaco={loadMonaco}
        focusTurn={focus ? focus.turnId : null}
        onShowAll={clearChangesFocus}
        {...(focus?.folder !== undefined && focus.path !== undefined ? { focusFile: { folder: focus.folder, path: focus.path, seq: focus.seq } } : {})}
        {...(code ? { onOpenFile: (folder: string, path: string, line?: number) => code.openFile(folder, path, line ? { line } : undefined) } : {})}
        {...(comments
          ? {
              onAddComment: (c: { folder: string; path: string; start: number; end: number; text: string }) => void comments.add(c),
              commentsFor: (folder: string, path: string) => comments.forFile(folder, path),
            }
          : {})}
      />
    </Panel>
  );
}
