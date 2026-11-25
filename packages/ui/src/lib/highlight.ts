/**
 * The chat / Markdown-preview code highlighter (contract v6 decision 16). Loaded with `import()` the first
 * time a fenced block renders, so it adds nothing to the initial bundle. A compact rule tokenizer per
 * language whose token classes take the editor's own palette (`codePalette.ts`); colours only — no weight
 * or style changes — so a block keeps its exact size when it upgrades from plain text. Unknown languages
 * return null and stay plain.
 */
import { CODE_DARK, CODE_PALETTES, type CodePalette } from "./codePalette";

/** Token kinds, named after the Monaco theme rules they mirror. */
export type TokenKind = "comment" | "keyword" | "string" | "number" | "type" | "muted" | "strong" | "added" | "removed" | "plain";
export type Token = { text: string; kind: TokenKind };

type Rule = [RegExp, TokenKind | ((match: string) => TokenKind)];

const words = (list: string) => new Set(list.split(" "));

const JS_KEYWORDS = words(
  "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
);
const GO_KEYWORDS = words(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota",
);
const GO_TYPES = words(
  "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any",
);
const PY_KEYWORDS = words(
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self",
);
const RS_KEYWORDS = words(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
);
const RS_TYPES = words("bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box");
const SH_KEYWORDS = words("if then else elif fi for while until do done case esac in function return export local readonly set unset source alias");
const SQL_KEYWORDS = words(
  "select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on as group by order having limit offset distinct union all null is in exists like between case when then else end returning with count sum avg min max",
);

const ident =
  (keywords: Set<string>, types?: Set<string>, pascalIsType = true) =>
  (m: string): TokenKind =>
    keywords.has(m) ? "keyword" : types?.has(m) ? "type" : pascalIsType && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(m) ? "type" : "plain";

const NUMBER: Rule = [/\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b/y, "number"];
const PUNCT: Rule = [/[{}()[\];,.:]/y, "muted"];
const OPERATOR: Rule = [/[=+\-*/%!<>&|^~?]+/y, "muted"];
const SPACE: Rule = [/\s+/y, "plain"];

const C_COMMENTS: Rule[] = [
  [/\/\/[^\n]*/y, "comment"],
  [/\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
];

const LANGS: Record<string, Rule[]> = {
  ts: [
    SPACE,
    ...C_COMMENTS,
    [/`(?:\\[\s\S]|[^`\\])*`?/y, "string"],
    [/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y, "string"],
    NUMBER,
    [/[A-Za-z_$][\w$]*/y, ident(JS_KEYWORDS)],
    PUNCT,
    OPERATOR,
  ],
  go: [
    SPACE,
    ...C_COMMENTS,
    [/`[^`]*`?/y, "string"],
    [/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y, "string"],
    NUMBER,
    [/[A-Za-z_]\w*/y, ident(GO_KEYWORDS, GO_TYPES, false)],
    PUNCT,
    OPERATOR,
  ],
  json: [
    SPACE,
    ...C_COMMENTS,
    // A key (string followed by a colon) takes the keyword colour, like Monaco's `string.key.json`.
    [/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, "keyword"],
    [/"(?:\\.|[^"\\\n])*"?/y, "string"],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, "number"],
    [/\b(?:true|false|null)\b/y, "number"],
    PUNCT,
  ],
  bash: [
    [/[ \t]+|\n/y, "plain"],
    [/#[^\n]*/y, "comment"],
    [/"(?:\\.|[^"\\])*"?|'[^']*'?/y, "string"],
    [/\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[0-9@#?*$!-]/y, "type"],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/y, "muted"],
    [/\b\d+\b/y, "number"],
    [/[A-Za-z_][\w.-]*/y, ident(SH_KEYWORDS, undefined, false)],
    [/[|&;<>()=]+/y, "muted"],
  ],
  python: [
    SPACE,
    [/#[^\n]*/y, "comment"],
    [/(?:[rbfRBF]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y, "string"],
    [/@[A-Za-z_][\w.]*/y, "muted"],
    NUMBER,
    [/[A-Za-z_]\w*/y, ident(PY_KEYWORDS)],
    PUNCT,
    OPERATOR,
  ],
  rust: [
    SPACE,
    ...C_COMMENTS,
    [/b?"(?:\\.|[^"\\])*"?/y, "string"],
    [/'[A-Za-z_]\w*(?!')/y, "type"],
    [/'(?:\\.|[^'\\])'/y, "string"],
    NUMBER,
    [/[A-Za-z_]\w*!/y, "keyword"],
    [/[A-Za-z_]\w*/y, ident(RS_KEYWORDS, RS_TYPES)],
    PUNCT,
    OPERATOR,
  ],
  css: [
    SPACE,
    [/\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
    [/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y, "string"],
    [/@[\w-]+/y, "keyword"],
    [/--?[A-Za-z][\w-]*(?=\s*:)|[A-Za-z][\w-]*(?=\s*:(?!:))/y, "number"],
    [/#[\da-fA-F]{3,8}\b/y, "number"],
    [/-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ms|s|deg|fr)?/y, "number"],
    [/[.#]?[A-Za-z_][\w-]*/y, "plain"],
    [/[{}();,:>+~*[\]=]/y, "muted"],
  ],
  yaml: [
    [/[ \t]+|\n/y, "plain"],
    [/#[^\n]*/y, "comment"],
    [/[A-Za-z_][\w.-]*(?=\s*:(?:\s|$))/y, "keyword"],
    [/"(?:\\.|[^"\\\n])*"?|'[^'\n]*'?/y, "string"],
    [/\b(?:true|false|null|yes|no|on|off)\b/y, "number"],
    [/-?\d+(?:\.\d+)?\b/y, "number"],
    [/[:\-[\]{},|>&*!]/y, "muted"],
    [/[^\s#:]+/y, "string"],
  ],
  toml: [
    [/[ \t]+|\n/y, "plain"],
    [/#[^\n]*/y, "comment"],
    [/\[\[?[^\]\n]*\]?\]?/y, "keyword"],
    [/[A-Za-z_][\w.-]*(?=\s*=)/y, "keyword"],
    [/"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*"?|'[^'\n]*'?/y, "string"],
    [/\b(?:true|false)\b/y, "number"],
    [/-?\d[\d_:.TZ-]*/y, "number"],
    [/[=,{}[\]]/y, "muted"],
    [/\S+/y, "plain"],
  ],
  sql: [
    SPACE,
    [/--[^\n]*/y, "comment"],
    [/\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
    [/'(?:''|[^'])*'?/y, "string"],
    [/\$\d+/y, "type"],
    NUMBER,
    [/[A-Za-z_]\w*/y, (m) => (SQL_KEYWORDS.has(m.toLowerCase()) ? "keyword" : "plain")],
    PUNCT,
    OPERATOR,
  ],
  html: [
    SPACE,
    [/<!--[\s\S]*?(?:-->|$)/y, "comment"],
    [/<\/?[A-Za-z][\w:-]*/y, "keyword"],
    [/\/?>/y, "keyword"],
    [/[A-Za-z_:][\w:.-]*(?==)/y, "number"],
    [/"[^"]*"?|'[^']*'?/y, "string"],
    [/[^<\s"'=]+/y, "plain"],
    [/=/y, "muted"],
  ],
};

const ALIASES: Record<string, string> = {
  typescript: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  mjs: "ts",
  cjs: "ts",
  golang: "go",
  jsonc: "json",
  json5: "json",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellscript: "bash",
  py: "python",
  rs: "rust",
  scss: "css",
  less: "css",
  yml: "yaml",
  xml: "html",
  svg: "html",
  vue: "html",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  patch: "diff",
};

/** The language a fence names, if we colour it. */
export function languageOf(lang: string | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const key = ALIASES[l] ?? l;
  return key === "diff" || key in LANGS ? key : null;
}

function push(out: Token[], text: string, kind: TokenKind) {
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

/** Diffs are line-based: additions, removals, hunk headers and file headers. */
function diff(code: string): Token[] {
  const out: Token[] = [];
  code.split(/(?<=\n)/).forEach((line) => {
    const kind: TokenKind = /^(?:\+\+\+|---|diff |index )/.test(line)
      ? "strong"
      : line.startsWith("@@")
        ? "keyword"
        : line.startsWith("+")
          ? "added"
          : line.startsWith("-")
            ? "removed"
            : "plain";
    push(out, line, kind);
  });
  return out;
}

/** Tokens for `code` in `lang`, or null for a language we leave plain. The tokens' text is exactly `code`. */
export function tokenize(code: string, lang: string | undefined): Token[] | null {
  const key = languageOf(lang);
  if (!key) return null;
  if (key === "diff") return diff(code);
  const rules = LANGS[key];
  if (!rules) return null;
  const out: Token[] = [];
  let i = 0;
  outer: while (i < code.length) {
    for (const [re, kind] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length > 0) {
        push(out, m[0], typeof kind === "function" ? kind(m[0]) : kind);
        i += m[0].length;
        continue outer;
      }
    }
    push(out, code[i] ?? "", "plain");
    i += 1;
  }
  return out;
}

const COLOR: Record<Exclude<TokenKind, "plain">, (p: CodePalette) => string> = {
  comment: (p) => p.comment,
  keyword: (p) => p.keyword,
  string: (p) => p.string,
  number: (p) => p.number,
  type: (p) => p.type,
  muted: (p) => p.muted,
  strong: (p) => p.strong,
  added: (p) => p.string,
  removed: (p) => p.err,
};

/** The token classes' colours for all themes, written once into the document (the palette is the source). */
export function installTokenStyles(doc: Document = document): void {
  if (doc.getElementById("octo-code-tokens")) return;
  const rules = (scope: string, p: CodePalette) =>
    Object.entries(COLOR)
      .map(([kind, color]) => `${scope} .octo-tok-${kind}{color:${color(p)}}`)
      .join("\n");
  const themed = (Object.entries(CODE_PALETTES) as [keyof typeof CODE_PALETTES, CodePalette][])
    .filter(([name]) => name !== "dark")
    .map(([name, palette]) => rules(`:root[data-theme="${name}"]`, palette));
  const style = doc.createElement("style");
  style.id = "octo-code-tokens";
  style.textContent = [rules(":root", CODE_DARK), ...themed, `:root .octo-tok-plain{color:inherit}`].join("\n");
  doc.head.appendChild(style);
}
