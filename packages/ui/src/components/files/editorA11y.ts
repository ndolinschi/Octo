/**
 * Item 3 of the polish pass (F3): the code editor's name and its way out. Monaco's Tab inserts a tab; its own toggle (Ctrl+M,
 * Ctrl+Shift+M on Apple platforms) makes Tab move focus instead, so the name says how to leave.
 */
export function isApple(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

/** "Editor: src/a.ts. Press Ctrl+M, then Tab, to move focus out." */
export function editorAriaLabel(path: string, apple: boolean): string {
  return `Editor: ${path}. Press ${apple ? "Ctrl+Shift+M" : "Ctrl+M"}, then Tab, to move focus out.`;
}

/**
 * When Esc leaves the editor for the file's tab: the caret is in the text, nothing is selected and no Monaco widget (find,
 * suggest, hover, peek, rename, parameter hints, an inline suggestion, snippet fields) would take the key itself.
 */
export const ESCAPE_OUT_WHEN = [
  "editorTextFocus",
  "!editorHasSelection",
  "!editorHasMultipleSelections",
  "!suggestWidgetVisible",
  "!findWidgetVisible",
  "!parameterHintsVisible",
  "!inlineSuggestionVisible",
  "!hoverVisible",
  "!markersNavigationVisible",
  "!referenceSearchVisible",
  "!renameInputVisible",
  "!inSnippetMode",
  "!accessibilityHelpWidgetVisible",
].join(" && ");
