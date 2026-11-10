/** LSP ↔ Monaco shapes. Defensive: servers send null, partial objects and older forms. */
import type * as Monaco from "monaco-editor";
import type { Problem, ProblemSeverity } from "./hub";

type MonacoApi = typeof Monaco;

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspDiagnostic = { range?: LspRange; severity?: number; message?: string; source?: string; code?: string | number; tags?: number[] };
export type LspLocation = { uri: string; range: LspRange };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isRange(v: unknown): v is LspRange {
  if (!isObj(v) || !isObj(v.start) || !isObj(v.end)) return false;
  return [v.start.line, v.start.character, v.end.line, v.end.character].every((n) => typeof n === "number");
}

export function toLspPosition(p: Monaco.IPosition): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toMonacoRange(r: LspRange): Monaco.IRange {
  return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
}

const SEVERITY: Record<number, ProblemSeverity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function toProblems(diagnostics: unknown): (Problem & { range: LspRange; code: string | null; tags: number[] })[] {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((d: LspDiagnostic) => {
    if (!isObj(d) || !isRange(d.range) || typeof d.message !== "string") return [];
    return [
      {
        severity: SEVERITY[d.severity ?? 1] ?? "error",
        message: d.message,
        source: typeof d.source === "string" ? d.source : null,
        code: d.code === undefined || d.code === null ? null : String(d.code),
        tags: Array.isArray(d.tags) ? d.tags : [],
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        range: d.range,
      },
    ];
  });
}

export function toMarkers(monaco: MonacoApi, problems: ReturnType<typeof toProblems>): Monaco.editor.IMarkerData[] {
  const S = monaco.MarkerSeverity;
  const severity = { error: S.Error, warning: S.Warning, info: S.Info, hint: S.Hint };
  return problems.map((p) => ({
    ...toMonacoRange(p.range),
    severity: severity[p.severity],
    message: p.message,
    source: p.source ?? undefined,
    code: p.code ?? undefined,
    tags: p.tags.flatMap((t) => (t === 1 ? [monaco.MarkerTag.Unnecessary] : t === 2 ? [monaco.MarkerTag.Deprecated] : [])),
  }));
}

/** MarkupContent | MarkedString | MarkedString[] → Monaco markdown strings. */
export function toHoverContents(contents: unknown): Monaco.IMarkdownString[] {
  const one = (c: unknown): Monaco.IMarkdownString[] => {
    if (typeof c === "string") return c.trim() ? [{ value: c }] : [];
    if (!isObj(c) || typeof c.value !== "string" || !c.value.trim()) return [];
    if (c.kind === "plaintext") return [{ value: c.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, "\\$&") }];
    if (typeof c.language === "string") return [{ value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` }];
    return [{ value: c.value }];
  };
  return Array.isArray(contents) ? contents.flatMap(one) : one(contents);
}

/** LSP CompletionItemKind (1-based) → Monaco's enum. */
export function completionKind(monaco: MonacoApi, kind: unknown): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  const table = [
    K.Text,
    K.Method,
    K.Function,
    K.Constructor,
    K.Field,
    K.Variable,
    K.Class,
    K.Interface,
    K.Module,
    K.Property,
    K.Unit,
    K.Value,
    K.Enum,
    K.Keyword,
    K.Snippet,
    K.Color,
    K.File,
    K.Reference,
    K.Folder,
    K.EnumMember,
    K.Constant,
    K.Struct,
    K.Event,
    K.Operator,
    K.TypeParameter,
  ];
  return typeof kind === "number" ? (table[kind - 1] ?? K.Text) : K.Text;
}

export function documentation(doc: unknown): string | Monaco.IMarkdownString | undefined {
  if (typeof doc === "string") return doc || undefined;
  if (isObj(doc) && typeof doc.value === "string") return doc.kind === "markdown" ? { value: doc.value } : doc.value;
  return undefined;
}

/** Location | Location[] | LocationLink[] → locations. */
export function toLocations(result: unknown): LspLocation[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.flatMap((l: unknown) => {
    if (!isObj(l)) return [];
    if (typeof l.uri === "string" && isRange(l.range)) return [{ uri: l.uri, range: l.range }];
    if (typeof l.targetUri === "string") {
      const range = isRange(l.targetSelectionRange) ? l.targetSelectionRange : isRange(l.targetRange) ? l.targetRange : null;
      return range ? [{ uri: l.targetUri, range }] : [];
    }
    return [];
  });
}
