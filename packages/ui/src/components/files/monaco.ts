/**
 * The only module that imports Monaco at runtime. It is reached exclusively through
 * `loadMonaco()` (a dynamic import), so Monaco, its CSS and its codicon font end up in
 * a lazily loaded chunk; workers are bundled locally by Vite (`?worker`), never fetched
 * from a CDN.
 */
import * as monaco from "monaco-editor";
import { CODE_PALETTES, type CodePalette as Palette } from "../../lib/codePalette";
import type { Theme } from "../../lib/theme";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Built-in TypeScript intelligence stays at syntax level: files are viewed out of their project
// context, so unresolved imports would paint every file red and hovers/completions would guess.
// Hover, completion and definitions come from the project's language servers (src/lsp) instead,
// which see the real project. Set before any model exists: the worker reads it once at setup.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSuggestionDiagnostics: true });
  defaults.setModeConfiguration({
    ...defaults.modeConfiguration,
    completionItems: false,
    hovers: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    signatureHelp: false,
    rename: false,
    codeActions: false,
    inlayHints: false,
  });
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    jsx: monaco.typescript.JsxEmit.Preserve,
    allowNonTsExtensions: true,
    allowJs: true,
  });
}
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: "ignore", enableSchemaRequest: false });

/* Themes derived from the UI tokens in styles.css; the palette is shared with the chat's code highlighter
   (`lib/codePalette.ts`), so code reads the same in the editor, the chat and the Markdown preview. */

/**
 * The editor's own chrome, from the UI tokens in styles.css (Monaco needs hex, so the values are written out here; keep them
 * equal to the tokens): the surface is the panel (`--octo-panel`), so the editor and the tree column are one surface split by
 * the column's hairline; the selection is `--octo-selection`; a find match is the accent at twice the selection's strength
 * (the current one) or at half of it (the others); the current line is the hover tint, never a box.
 */
type Chrome = {
  background: string;
  selection: string;
  selectionInactive: string;
  findMatch: string;
  findOthers: string;
  currentLine: string;
  /** `--octo-ok` / `--octo-err`: the diff tints (see `diffColors`). */
  ok: string;
  err: string;
};
const DARK_CHROME: Chrome = {
  background: "#171717",
  selection: "#5c9dff52",
  selectionInactive: "#5c9dff29",
  findMatch: "#5c9dff8c",
  findOthers: "#5c9dff33",
  currentLine: "#ffffff0d",
  ok: "#5fbf7f",
  err: "#f6847e",
};
const CURSOR_CHROME: Chrome = {
  background: "#18181b",
  selection: "#4da3ff4d",
  selectionInactive: "#4da3ff26",
  findMatch: "#4da3ff85",
  findOthers: "#4da3ff33",
  currentLine: "#ffffff0d",
  ok: "#4ec9b0",
  err: "#f17878",
};
const CLAUDE_CHROME: Chrome = {
  background: "#1c1a17",
  selection: "#d9775747",
  selectionInactive: "#d9775724",
  findMatch: "#d9775780",
  findOthers: "#d9775730",
  currentLine: "#ffffff0d",
  ok: "#68b87d",
  err: "#eb7a72",
};
const CODEX_CHROME: Chrome = {
  background: "#14171c",
  selection: "#38b88947",
  selectionInactive: "#38b88924",
  findMatch: "#38b88980",
  findOthers: "#38b88930",
  currentLine: "#ffffff0d",
  ok: "#4cc38a",
  err: "#f07b78",
};
const OPENCODE_CHROME: Chrome = {
  background: "#131318",
  selection: "#9b8aff47",
  selectionInactive: "#9b8aff24",
  findMatch: "#9b8aff80",
  findOthers: "#9b8aff30",
  currentLine: "#ffffff0d",
  ok: "#5dc286",
  err: "#f27c85",
};
const LIGHT_CHROME: Chrome = {
  background: "#ffffff",
  selection: "#0a66e033",
  selectionInactive: "#0a66e01a",
  findMatch: "#0a66e066",
  findOthers: "#0a66e01f",
  currentLine: "#00000009",
  ok: "#17703d",
  err: "#b42a23",
};
const CHROME: Record<Theme, Chrome> = {
  dark: DARK_CHROME,
  cursor: CURSOR_CHROME,
  claude: CLAUDE_CHROME,
  codex: CODEX_CHROME,
  opencode: OPENCODE_CHROME,
  light: LIGHT_CHROME,
};

/**
 * Item 8: the diff editors (Changes, Review) use the conversation's diff tints (styles.css, `.octo-diff`): a changed line is
 * the ok / err token at 9 % / 8 % (it runs under the line numbers too), a changed word at 18 % / 15 % (alpha hex: 9 % = 17,
 * 8 % = 14, 18 % = 2e, 15 % = 26). The gutter keys stay transparent: in the inline layout Monaco paints the removed-gutter
 * colour down the old-number column of the whole hunk, inserted lines included. No borders; the overview marks are at 60 %.
 */
function diffColors(chrome: Chrome, p: Palette): Record<string, string> {
  const none = "#00000000";
  return {
    "diffEditor.insertedLineBackground": `${chrome.ok}17`,
    "diffEditor.removedLineBackground": `${chrome.err}14`,
    "diffEditor.insertedTextBackground": `${chrome.ok}2e`,
    "diffEditor.removedTextBackground": `${chrome.err}26`,
    "diffEditorGutter.insertedLineBackground": none,
    "diffEditorGutter.removedLineBackground": none,
    "diffEditor.insertedTextBorder": none,
    "diffEditor.removedTextBorder": none,
    "diffEditor.border": p.tint("17"),
    "diffEditor.diagonalFill": p.tint("14"),
    "diffEditorOverview.insertedForeground": `${chrome.ok}99`,
    "diffEditorOverview.removedForeground": `${chrome.err}99`,
    "diffEditor.unchangedRegionBackground": p.raised,
    "diffEditor.unchangedRegionForeground": p.muted,
    "diffEditor.unchangedCodeBackground": none,
    "diffEditor.move.border": p.tint("33"),
    "diffEditor.moveActive.border": p.tint("60"),
  };
}

function theme(base: "vs" | "vs-dark", p: Palette, chrome: Chrome): monaco.editor.IStandaloneThemeData {
  const background = chrome.background;
  const c = (hex: string) => hex.slice(1);
  const rule = (token: string, color: string, fontStyle?: string): monaco.editor.ITokenThemeRule =>
    fontStyle === undefined ? { token, foreground: c(color) } : { token, foreground: c(color), fontStyle };
  return {
    base,
    inherit: true,
    rules: [
      rule("", p.text),
      rule("comment", p.comment, "italic"),
      rule("keyword", p.keyword),
      rule("keyword.flow", p.keyword),
      rule("keyword.json", p.number),
      rule("storage", p.keyword),
      rule("string", p.string),
      rule("string.escape", p.number),
      rule("string.key.json", p.keyword),
      rule("string.value.json", p.string),
      rule("string.link", p.link),
      rule("number", p.number),
      rule("number.json", p.number),
      rule("constant", p.number),
      rule("regexp", p.number),
      rule("type", p.type),
      rule("type.identifier", p.type),
      rule("identifier", p.text),
      rule("variable", p.text),
      rule("variable.predefined", p.strong),
      rule("predefined", p.strong),
      rule("namespace", p.text),
      rule("annotation", p.muted),
      rule("delimiter", p.muted),
      rule("delimiter.html", p.muted),
      rule("delimiter.xml", p.muted),
      rule("operator", p.muted),
      rule("tag", p.keyword),
      rule("tag.html", p.keyword),
      rule("metatag", p.muted),
      rule("attribute.name", p.number),
      rule("attribute.value", p.string),
      rule("attribute.value.number", p.number),
      rule("attribute.value.unit", p.number),
      rule("attribute.value.hex", p.number),
      rule("key", p.keyword),
      rule("emphasis", p.text, "italic"),
      rule("strong", p.strong, "bold"),
      rule("invalid", p.err),
    ],
    colors: {
      "editor.background": background,
      "editor.foreground": p.text,
      "editorGutter.background": background,
      "editorLineNumber.foreground": p.lineNumber,
      "editorLineNumber.activeForeground": p.lineNumberActive,
      "editorCursor.foreground": p.strong,
      "editor.lineHighlightBackground": chrome.currentLine,
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": chrome.selection,
      "editor.inactiveSelectionBackground": chrome.selectionInactive,
      "editor.selectionHighlightBackground": chrome.findOthers,
      "editor.wordHighlightBackground": p.tint("12"),
      "editor.wordHighlightStrongBackground": p.tint("18"),
      "editor.findMatchBackground": chrome.findMatch,
      "editor.findMatchHighlightBackground": chrome.findOthers,
      "editor.findMatchBorder": "#00000000",
      "editor.findMatchHighlightBorder": "#00000000",
      // Inline completion: the meta tone (styles.css also keeps it upright).
      "editorGhostText.foreground": p.comment,
      "editorGhostText.border": "#00000000",
      "editor.rangeHighlightBackground": p.tint("0a"),
      "editorWhitespace.foreground": p.tint("1f"),
      "editorIndentGuide.background1": p.tint("0d"),
      "editorIndentGuide.activeBackground1": p.tint("24"),
      "editorBracketMatch.background": p.tint("12"),
      "editorBracketMatch.border": p.tint("33"),
      "editorOverviewRuler.border": "#00000000",
      // Brackets stay grey (no pair colourisation).
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, p.muted])),
      "editorBracketHighlight.unexpectedBracket.foreground": p.err,
      // Diagnostics: squiggles in the err / warn tokens; unused code fades.
      "editorError.foreground": p.err,
      "editorWarning.foreground": p.warn,
      "editorInfo.foreground": p.muted,
      "editorHint.foreground": p.muted,
      "editorUnnecessaryCode.opacity": "#000000a0",
      "editorLink.activeForeground": p.link,
      "textLink.foreground": p.link,
      "textLink.activeForeground": p.link,
      "textCodeBlock.background": p.raised,
      "textPreformat.foreground": p.strong,
      // Widgets (hover, suggest, peek, find) use the overlay surface and the hairline of dialogs.
      "editorWidget.background": p.overlay,
      "editorWidget.foreground": p.strong,
      "editorWidget.border": p.tint("17"),
      "editorWidget.resizeBorder": p.tint("24"),
      "editorHoverWidget.background": p.overlay,
      "editorHoverWidget.foreground": p.strong,
      "editorHoverWidget.border": p.tint("17"),
      "editorHoverWidget.highlightForeground": p.strong,
      "editorHoverWidget.statusBarBackground": p.overlay,
      "editorSuggestWidget.background": p.overlay,
      "editorSuggestWidget.border": p.tint("17"),
      "editorSuggestWidget.foreground": p.text,
      "editorSuggestWidget.selectedBackground": p.tint("1a"),
      "editorSuggestWidget.selectedForeground": p.strong,
      "editorSuggestWidget.selectedIconForeground": p.strong,
      "editorSuggestWidget.highlightForeground": p.strong,
      "editorSuggestWidget.focusHighlightForeground": p.strong,
      "editorMarkerNavigation.background": p.overlay,
      "editorMarkerNavigationError.background": p.err,
      "editorMarkerNavigationWarning.background": p.warn,
      "peekView.border": p.tint("24"),
      "peekViewTitle.background": p.overlay,
      "peekViewTitleLabel.foreground": p.strong,
      "peekViewTitleDescription.foreground": p.muted,
      "peekViewResult.background": p.overlay,
      "peekViewResult.fileForeground": p.strong,
      "peekViewResult.lineForeground": p.muted,
      "peekViewResult.selectionBackground": p.tint("1a"),
      "peekViewResult.selectionForeground": p.strong,
      "peekViewResult.matchHighlightBackground": p.tint("24"),
      "peekViewEditor.background": background,
      "peekViewEditorGutter.background": background,
      "peekViewEditor.matchHighlightBackground": p.tint("24"),
      "editorStickyScroll.background": background,
      "input.background": p.raised,
      "input.border": p.tint("17"),
      "inputOption.activeBorder": p.tint("60"),
      focusBorder: p.tint("99"),
      "list.hoverBackground": p.tint("0d"),
      "list.hoverForeground": p.strong,
      "list.activeSelectionBackground": p.tint("1a"),
      "list.activeSelectionForeground": p.strong,
      "list.inactiveSelectionBackground": p.tint("14"),
      "list.focusBackground": p.tint("1a"),
      "list.focusForeground": p.strong,
      "list.focusOutline": "#00000000",
      "list.highlightForeground": p.strong,
      "list.focusHighlightForeground": p.strong,
      "menu.background": p.overlay,
      "menu.foreground": p.strong,
      "menu.selectionBackground": p.tint("14"),
      "menu.selectionForeground": p.strong,
      "menu.separatorBackground": p.tint("17"),
      "widget.shadow": base === "vs-dark" ? "#00000080" : "#0000001f",
      "scrollbar.shadow": "#00000000",
      // Same quiet neutral thumb as the app's scrollbars (line-strong), stronger on hover and drag;
      // its slim, rounded shape is in styles.css.
      "scrollbarSlider.background": p.tint("1f"),
      "scrollbarSlider.hoverBackground": p.tint("38"),
      "scrollbarSlider.activeBackground": p.tint("4d"),
      ...diffColors(chrome, p),
    },
  };
}

for (const name of Object.keys(CHROME) as Theme[]) {
  monaco.editor.defineTheme(`octo-${name}`, theme(name === "light" ? "vs" : "vs-dark", CODE_PALETTES[name], CHROME[name]));
}

// One palette in the app (Ctrl/Cmd+K): Monaco's own command palette (F1) is switched off for every editor.
monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: "-editor.action.quickCommand" });

export function themeName(mode: Theme): string {
  return `octo-${mode}`;
}

export { monaco };

/* Editor features that only exist once Monaco does: code comments and the language-server client. */
export { EditorComments } from "./editor/EditorComments";
export { LspManager } from "../../lsp/manager";
