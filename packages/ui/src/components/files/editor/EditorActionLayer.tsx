import { ArrowUp, MessageSquare, Sparkles, X } from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { chatMention, selectedLines } from "../../../lib/chatMention";
import { visibleComposer } from "../../../lib/focus";
import { useLatest } from "../../../lib/hooks";
import { MOD_LABEL } from "../../../lib/keys";
import { addToChat, canAddToChat, canSubmitToChat, submitToChat } from "../../../state/chatInsert";
import { Button } from "../../primitives/Button";
import { Glyph } from "../../primitives/Glyph";
import { IconButton } from "../../primitives/IconButton";
import { TextField } from "../../primitives/TextField";
import type { MonacoApi } from "../../../lib/buffers";

const MAC = MOD_LABEL === "⌘";

type Anchor = { top: number; left: number };

type InlineEditTarget = {
  mention: string;
  anchor: Anchor;
};

const BAR_HEIGHT = 30;
const INLINE_WIDTH = 440;
const INLINE_HEIGHT = 76;

/** Computes a clamped position inside the editor host for a floating bar anchored to `line` / `column`. */
function anchorFor(editor: Monaco.editor.IStandaloneCodeEditor, line: number, column: number, barHeight: number, barWidth: number): Anchor | null {
  const layout = editor.getLayoutInfo();
  if (layout.width <= 0 || layout.height <= 0) return null;
  const pos = editor.getScrolledVisiblePosition({ lineNumber: line, column });
  if (!pos) return null;
  const above = pos.top - barHeight - 6;
  const top = above >= 6 ? above : Math.min(layout.height - barHeight - 6, pos.top + pos.height + 6);
  const left = Math.max(8, Math.min(pos.left, Math.max(8, layout.width - barWidth - 8)));
  return { top: Math.max(6, Math.round(top)), left: Math.round(left) };
}

/**
 * Cursor-style editor coding actions:
 * - `Mod+L`: attaches the selected lines (`@path:from-to`) or current file (`@path`) to chat and focuses the composer.
 * - `Mod+I` (and `"octo.inlineEdit"` action): opens a compact inline edit prompt anchored at the selection/cursor that sends a targeted edit to the agent.
 * - `Mod+G`: triggers Monaco's Go to Line widget on both macOS and Linux/Windows.
 * - Floating selection pill above non-empty selections (`Add to chat`, `Edit`, `Comment`).
 */
export function EditorActionLayer(props: { editor: Monaco.editor.IStandaloneCodeEditor; monaco: MonacoApi; path: string; readOnly?: boolean }) {
  const { editor, monaco, path, readOnly = false } = props;
  const [selectionBar, setSelectionBar] = useState<{ mention: string; anchor: Anchor } | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditTarget | null>(null);
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const pathRef = useLatest(path);
  const readOnlyRef = useLatest(readOnly);
  const inlineOpenRef = useLatest(inlineEdit !== null);

  const openInlineEdit = useCallback(() => {
    if (readOnlyRef.current || !canSubmitToChat()) return;
    const sel = editor.getSelection();
    const pos = sel ? sel.getStartPosition() : editor.getPosition();
    if (!pos) return;
    const lines =
      sel && !sel.isEmpty()
        ? selectedLines({
            startLine: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLine: sel.endLineNumber,
            endColumn: sel.endColumn,
          })
        : { from: pos.lineNumber, to: pos.lineNumber };
    const mention = chatMention(pathRef.current, lines);
    const anchor = anchorFor(editor, pos.lineNumber, pos.column, INLINE_HEIGHT, Math.min(INLINE_WIDTH, editor.getLayoutInfo().width - 16)) ?? {
      top: 12,
      left: 12,
    };
    setSelectionBar(null);
    setInstruction("");
    setInlineEdit({ mention, anchor });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [editor, pathRef, readOnlyRef]);

  const sendSelectionToChat = useCallback(() => {
    const sel = editor.getSelection();
    if (!canAddToChat()) {
      visibleComposer()?.focus();
      return;
    }
    const mention =
      sel && !sel.isEmpty()
        ? chatMention(
            pathRef.current,
            selectedLines({
              startLine: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLine: sel.endLineNumber,
              endColumn: sel.endColumn,
            }),
          )
        : chatMention(pathRef.current);
    setSelectionBar(null);
    addToChat(mention);
  }, [editor, pathRef]);

  const runComment = useCallback(() => {
    setSelectionBar(null);
    void editor.getAction("octo.addComment")?.run();
  }, [editor]);

  // Register Mod+L, Mod+I (and "octo.inlineEdit" for the right-click menu), and Mod+G inside Monaco.
  useEffect(() => {
    const inlineAction = editor.addAction({
      id: "octo.inlineEdit",
      label: "Edit with agent",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      run: () => openInlineEdit(),
    });
    const chatAction = editor.addAction({
      id: "octo.addSelectionToChat",
      label: "Add selection to chat",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      run: () => sendSelectionToChat(),
    });
    const gotoAction = editor.addAction({
      id: "octo.goToLine",
      label: "Go to line",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG],
      run: () => void editor.getAction("editor.action.gotoLine")?.run(),
    });
    return () => {
      inlineAction.dispose();
      chatAction.dispose();
      gotoAction.dispose();
    };
  }, [editor, monaco, openInlineEdit, sendSelectionToChat]);

  // Track non-empty selection to position the subtle floating pill above it.
  useEffect(() => {
    const update = () => {
      if (inlineOpenRef.current) {
        setSelectionBar(null);
        return;
      }
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty() || (!canAddToChat() && (readOnlyRef.current || !canSubmitToChat()))) {
        setSelectionBar(null);
        return;
      }
      const lines = selectedLines({
        startLine: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLine: sel.endLineNumber,
        endColumn: sel.endColumn,
      });
      const anchor = anchorFor(editor, sel.startLineNumber, sel.startColumn, BAR_HEIGHT, 240);
      if (!anchor) {
        setSelectionBar(null);
        return;
      }
      setSelectionBar({ mention: chatMention(pathRef.current, lines), anchor });
    };
    const subSel = editor.onDidChangeCursorSelection(update);
    const subScroll = editor.onDidScrollChange(update);
    const subModel = editor.onDidChangeModel(() => {
      setSelectionBar(null);
      setInlineEdit(null);
    });
    const subBlur = editor.onDidBlurEditorText(() => {
      // Allow clicking the pill buttons (which preventDefault on mousedown) without flicker.
      setSelectionBar(null);
    });
    return () => {
      subSel.dispose();
      subScroll.dispose();
      subModel.dispose();
      subBlur.dispose();
    };
  }, [editor, pathRef, readOnlyRef, inlineOpenRef]);

  const closeInline = () => {
    setInlineEdit(null);
    setInstruction("");
    editor.focus();
  };

  const submitInline = (e?: SyntheticEvent) => {
    e?.preventDefault();
    const trimmed = instruction.trim();
    if (!inlineEdit || !trimmed) return;
    const ok = submitToChat(`Edit ${inlineEdit.mention} — ${trimmed}`);
    if (ok) {
      setInlineEdit(null);
      setInstruction("");
    }
  };

  const canComment = Boolean(editor.getAction("octo.addComment")?.isSupported());
  const canEdit = !readOnly && canSubmitToChat();
  const canChat = canAddToChat();

  return (
    <>
      {selectionBar && !inlineEdit && (canChat || canEdit) && (
        <div
          data-editor-selection-bar
          role="toolbar"
          aria-label="Selection actions"
          style={{ top: selectionBar.anchor.top, left: selectionBar.anchor.left }}
          onMouseDown={(e) => e.preventDefault()}
          className="border-line-2 absolute z-20 flex items-center gap-0.5 rounded-md border bg-raised px-1 py-0.5 shadow-pop"
        >
          {canChat && (
            <Button
              variant="quiet"
              size="xs"
              title={`Add ${selectionBar.mention} to chat (${MAC ? "⌘L" : "Ctrl+L"})`}
              onClick={sendSelectionToChat}
              className="gap-1.5 text-fg-2 hover:text-fg"
            >
              <span>Add to chat</span>
              <span className="text-2xs font-mono text-fg-3">{MAC ? "⌘L" : "Ctrl+L"}</span>
            </Button>
          )}
          {canEdit && (
            <Button
              variant="quiet"
              size="xs"
              icon={Sparkles}
              title={`Edit ${selectionBar.mention} with agent (${MAC ? "⌘I" : "Ctrl+I"})`}
              onClick={openInlineEdit}
              className="gap-1 text-fg-2 hover:text-fg"
            >
              <span>Edit</span>
              <span className="text-2xs font-mono text-fg-3">{MAC ? "⌘I" : "Ctrl+I"}</span>
            </Button>
          )}
          {canComment && (
            <IconButton icon={MessageSquare} size="xs" label="Comment on selected lines" shortcut={MAC ? "⌘⌥C" : "Ctrl+Alt+C"} onClick={runComment} />
          )}
        </div>
      )}

      {inlineEdit && (
        <form
          data-inline-edit-bar
          aria-label="Inline edit with agent"
          onSubmit={submitInline}
          style={{ top: inlineEdit.anchor.top, left: inlineEdit.anchor.left, width: "min(440px, calc(100% - 16px))" }}
          className="border-line-2 absolute z-30 flex flex-col gap-1.5 rounded-lg border bg-raised p-2 shadow-pop"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
              <Glyph icon={Sparkles} size={14} className="shrink-0 text-fg-3" />
              <span className="truncate font-mono text-fg">{inlineEdit.mention}</span>
            </span>
            <IconButton icon={X} size="xs" label="Cancel inline edit" onClick={closeInline} />
          </div>
          <div className="flex items-center gap-1.5">
            <TextField
              ref={inputRef}
              size="sm"
              touchSize="sm"
              aria-label="Edit instructions"
              placeholder="Describe the change… (Enter to send)"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeInline();
                }
              }}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" size="sm" icon={ArrowUp} disabled={!instruction.trim()} title="Send edit instruction to agent">
              Edit
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
