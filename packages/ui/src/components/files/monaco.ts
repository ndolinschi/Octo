/**
 * The only module that imports Monaco at runtime. It is reached exclusively through
 * `loadMonaco()` (a dynamic import), so Monaco, its CSS and its codicon font end up in
 * a lazily loaded chunk; workers are bundled locally by Vite (`?worker`), never fetched
 * from a CDN.
 */
import * as monaco from "monaco-editor";
import { CODE_DARK, CODE_LIGHT, type CodePalette } from "../../lib/codePalette";
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
type Palette = CodePalette;
const DARK = CODE_DARK;
const LIGHT = CODE_LIGHT;

function theme(base: "vs" | "vs-dark", p: Palette, background: string): monaco.editor.IStandaloneThemeData {
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
      "editor.lineHighlightBackground": p.tint("08"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": p.tint("24"),
      "editor.inactiveSelectionBackground": p.tint("14"),
      "editor.selectionHighlightBackground": p.tint("12"),
      "editor.wordHighlightBackground": p.tint("12"),
      "editor.wordHighlightStrongBackground": p.tint("18"),
      "editor.findMatchBackground": p.tint("38"),
      "editor.findMatchHighlightBackground": p.tint("1a"),
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
      "scrollbarSlider.background": p.tint("24"),
      "scrollbarSlider.hoverBackground": p.tint("3d"),
      "scrollbarSlider.activeBackground": p.tint("52"),
    },
  };
}

/* The editor always sits on an inset panel (`--octo-panel`). */
monaco.editor.defineTheme("octo-dark", theme("vs-dark", DARK, "#141414"));
monaco.editor.defineTheme("octo-light", theme("vs", LIGHT, "#ffffff"));

export function themeName(mode: "dark" | "light"): string {
  return `octo-${mode}`;
}

export { monaco };

/* Editor features that only exist once Monaco does: code comments and the language-server client. */
export { EditorComments } from "./editor/EditorComments";
export { LspManager } from "../../lsp/manager";
