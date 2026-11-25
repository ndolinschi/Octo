import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { chatMention, selectedLines } from "../../lib/chatMention";
import { addToChat, canAddToChat } from "../../state/chatInsert";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";

/** The editor's actions this menu offers when they exist and apply (the language servers decide the last two). */
const COMMENT_IDS = ["octo.addComment", "octo.v7.comment"];
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type At = { x: number; y: number };

/**
 * The code editor's right-click menu, drawn by the app's own `Menu` instead of Monaco's (which lives in a shadow root the
 * theme cannot reach, paints no surface and carries a second command palette). The editor is created with `contextmenu: false`;
 * this listens for its context-menu event, offers Add to chat (G4: the selected lines as a mention in the composer), Add
 * comment, Go to definition and Find references where they apply, then
 * Cut / Copy / Paste (Cut and Paste only when editable) and Copy path. `path` is the file's project-relative path, when known.
 */
export function EditorContextMenu({ editor, path }: { editor: Monaco.editor.ICodeEditor; path?: string | undefined }) {
  const [at, setAt] = useState<At | null>(null);
  useEffect(() => {
    const sub = editor.onContextMenu((e) => {
      const ev = e.event.browserEvent;
      ev.preventDefault();
      setAt({ x: ev.clientX, y: ev.clientY });
    });
    return () => sub.dispose();
  }, [editor]);

  const items = at ? build(editor, path) : [];
  return (
    <Presence show={at !== null && items.length > 0}>{at && <Menu label="Editor" x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}</Presence>
  );
}

function build(editor: Monaco.editor.ICodeEditor, path: string | undefined): MenuItem[] {
  const editable = !editor.getRawOptions().readOnly;
  const sel = editor.getSelection();
  const text = sel && !sel.isEmpty() ? (editor.getModel()?.getValueInRange(sel) ?? "") : "";
  const action = (id: string) => {
    const a = editor.getAction(id);
    return a?.isSupported() ? a : null;
  };
  const comment = COMMENT_IDS.map(action).find(Boolean) ?? null;
  const inlineEdit = editable ? action("octo.inlineEdit") : null;
  const define = action("editor.action.revealDefinition");
  const refs = action("editor.action.goToReferences");
  const nav: MenuItem[] = [];
  if (comment) nav.push({ id: "comment", label: "Add comment", shortcut: MAC ? "⌘⌥C" : "Ctrl+Alt+C", run: () => void comment.run() });
  if (define) nav.push({ id: "definition", label: "Go to definition", shortcut: "F12", run: () => void define.run() });
  if (refs) nav.push({ id: "references", label: "Find references", shortcut: "Shift+F12", run: () => void refs.run() });
  // Cursor-style inline agent edit (Mod+I) for the selection or current line.
  if (inlineEdit && path && sel) {
    nav.unshift({ id: "inline-edit", label: "Edit with agent", shortcut: MAC ? "⌘I" : "Ctrl+I", run: () => void inlineEdit.run() });
  }
  // G4: the selection's lines (or the caret's line) as a file mention in the conversation's composer.
  if (path && sel && canAddToChat()) {
    const lines = selectedLines({ startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn });
    nav.unshift({ id: "chat", label: "Add to chat", shortcut: MAC ? "⌘L" : "Ctrl+L", run: () => void addToChat(chatMention(path, lines)) });
  }

  const clip: MenuItem[] = [];
  if (editable) clip.push({ id: "cut", label: "Cut", disabled: !text, run: () => void cut(editor, text) });
  clip.push({ id: "copy", label: "Copy", disabled: !text, run: () => void navigator.clipboard.writeText(text) });
  if (editable) clip.push({ id: "paste", label: "Paste", run: () => void paste(editor) });
  if (path) clip.push({ id: "path", label: "Copy path", run: () => void navigator.clipboard.writeText(path) });

  return nav.length ? [...nav, { id: "sep", separator: true }, ...clip] : clip;
}

async function cut(editor: Monaco.editor.ICodeEditor, text: string) {
  const sel = editor.getSelection();
  if (!sel || !text) return;
  await navigator.clipboard.writeText(text);
  editor.executeEdits("octo.cut", [{ range: sel, text: "" }]);
  editor.focus();
}

async function paste(editor: Monaco.editor.ICodeEditor) {
  const sel = editor.getSelection();
  editor.focus();
  if (!sel) return;
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) editor.executeEdits("octo.paste", [{ range: sel, text }]);
}
