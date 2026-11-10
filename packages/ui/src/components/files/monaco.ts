/**
 * The only module that imports Monaco at runtime. It is reached exclusively through
 * `loadMonaco()` (a dynamic import), so Monaco, its CSS and its codicon font end up in
 * a lazily loaded chunk; workers are bundled locally by Vite (`?worker`), never fetched
 * from a CDN.
 */
import * as monaco from "monaco-editor";
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

// No language servers beyond syntax: files are viewed out of their project context, so
// unresolved imports would paint every file red. Syntax errors still show.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSuggestionDiagnostics: true });
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    jsx: monaco.typescript.JsxEmit.Preserve,
    allowNonTsExtensions: true,
    allowJs: true,
  });
}
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: "ignore", enableSchemaRequest: false });

/* Themes derived from the UI tokens in styles.css. Syntax uses three muted hues
   (keyword, string, number) over the grey ramp; everything else is grey. */
type Palette = {
  text: string;
  strong: string;
  muted: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  lineNumber: string;
  lineNumberActive: string;
  overlay: string;
  raised: string;
  err: string;
  link: string;
  /** Alpha-suffixed neutral (white in dark, black in light). */
  tint: (alpha: string) => string;
};

const DARK: Palette = {
  text: "#d4d4d4",
  strong: "#e6e6e6",
  muted: "#9a9a9a",
  comment: "#808080",
  keyword: "#a9b6c9",
  string: "#b4c1a4",
  number: "#ccb491",
  lineNumber: "#5e5e5e",
  lineNumberActive: "#a3a3a3",
  overlay: "#1f1f1f",
  raised: "#212121",
  err: "#f0726b",
  link: "#6fa8ff",
  tint: (a) => `#ffffff${a}`,
};

const LIGHT: Palette = {
  text: "#2b2b2b",
  strong: "#1a1a1a",
  muted: "#6b6b6b",
  comment: "#737373",
  keyword: "#3b5577",
  string: "#4b6a3d",
  number: "#82602c",
  lineNumber: "#a8a8a8",
  lineNumberActive: "#5c5c5c",
  overlay: "#ffffff",
  raised: "#f0f0f0",
  err: "#c4312a",
  link: "#0a5fd1",
  tint: (a) => `#000000${a}`,
};

function theme(base: "vs" | "vs-dark", p: Palette, background: string): monaco.editor.IStandaloneThemeData {
  const c = (hex: string) => hex.slice(1);
  const rule = (token: string, color: string, fontStyle?: string) => ({ token, foreground: c(color), fontStyle });
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
      rule("type", p.strong),
      rule("type.identifier", p.strong),
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
      "editorError.foreground": p.err,
      "editorWarning.foreground": p.number,
      "editorInfo.foreground": p.muted,
      "editorLink.activeForeground": p.link,
      "editorWidget.background": p.overlay,
      "editorWidget.foreground": p.strong,
      "editorWidget.border": p.tint("17"),
      "editorHoverWidget.background": p.overlay,
      "editorHoverWidget.border": p.tint("17"),
      "editorSuggestWidget.background": p.overlay,
      "editorSuggestWidget.border": p.tint("17"),
      "editorSuggestWidget.selectedBackground": p.tint("14"),
      "editorSuggestWidget.highlightForeground": p.strong,
      "editorStickyScroll.background": background,
      "input.background": p.raised,
      "input.border": p.tint("17"),
      "inputOption.activeBorder": p.tint("60"),
      "focusBorder": p.tint("99"),
      "list.hoverBackground": p.tint("0d"),
      "list.activeSelectionBackground": p.tint("14"),
      "list.activeSelectionForeground": p.strong,
      "list.focusBackground": p.tint("14"),
      "list.highlightForeground": p.strong,
      "menu.background": p.overlay,
      "menu.foreground": p.strong,
      "menu.selectionBackground": p.tint("14"),
      "menu.selectionForeground": p.strong,
      "menu.separatorBackground": p.tint("17"),
      "widget.shadow": base === "vs-dark" ? "#00000080" : "#0000001f",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": p.tint("24"),
      "scrollbarSlider.hoverBackground": p.tint("33"),
      "scrollbarSlider.activeBackground": p.tint("40"),
    },
  };
}

/** Surface the pane sits on: docked (`bg`) or overlaid (`overlay`). */
export type Surface = "docked" | "overlay";

monaco.editor.defineTheme("octo-dark-docked", theme("vs-dark", DARK, "#161616"));
monaco.editor.defineTheme("octo-dark-overlay", theme("vs-dark", DARK, "#1f1f1f"));
monaco.editor.defineTheme("octo-light-docked", theme("vs", LIGHT, "#fbfbfb"));
monaco.editor.defineTheme("octo-light-overlay", theme("vs", LIGHT, "#ffffff"));

export function themeName(mode: "dark" | "light", surface: Surface): string {
  return `octo-${mode}-${surface}`;
}

export { monaco };
