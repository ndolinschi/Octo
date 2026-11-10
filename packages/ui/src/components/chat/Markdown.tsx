import { Check, Copy } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopy } from "../../lib/hooks";
import { InlineCode } from "./FileLink";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

type Highlighter = typeof import("../../lib/highlight");
let highlighter: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

/** Loads the highlighter chunk once (decision 16); the first blocks render plain meanwhile. */
function loadHighlighter(): Promise<Highlighter> {
  loading ??= import("../../lib/highlight").then((m) => {
    m.installTokenStyles();
    highlighter = m;
    return m;
  });
  return loading;
}

/** Coloured tokens for a fenced block once the highlighter is in; null (plain) before and for unknown languages. */
function useTokens(code: string, lang: string | undefined) {
  const [, setReady] = useState(highlighter !== null);
  useEffect(() => {
    if (highlighter || !lang) return;
    let live = true;
    // A failed chunk load leaves the block plain, which is still correct.
    loadHighlighter().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [lang]);
  return useMemo(() => (highlighter && lang ? highlighter.tokenize(code, lang) : null), [code, lang, highlighter]);
}

/** `code` with the highlighter's token colours for `lang` once it is loaded (plain until then); same metrics. */
export function HighlightedCode({ code, lang }: { code: string; lang: string | undefined }) {
  const tokens = useTokens(code, lang);
  return (
    <>
      {tokens
        ? tokens.map((t, i) =>
            t.kind === "plain" ? (
              t.text
            ) : (
              <span key={i} className={`octo-tok-${t.kind}`}>
                {t.text}
              </span>
            ),
          )
        : code}
    </>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, copy] = useCopy();
  const child: unknown = Array.isArray(children) ? children[0] : children;
  const className = child && typeof child === "object" && "props" in child ? ((child as { props: { className?: string } }).props.className ?? "") : "";
  const lang = /language-([\w+-]+)/.exec(className)?.[1];
  const code = textOf(children).replace(/\n$/, "");
  return (
    // Card inset 12 on all sides: a 20px caption row, 8 below it, then 20px code lines.
    <div className="my-3 overflow-hidden rounded-md bg-code-bg p-card">
      <div className="mb-2 flex h-5 items-center">
        <span className="font-mono text-xs text-fg-3">{lang ?? "text"}</span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="-my-0.5 -mr-2 ml-auto inline-flex h-6 press items-center gap-1.5 rounded-sm px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg"
        >
          {copied ? <Glyph icon={Check} size={14} /> : <Glyph icon={Copy} size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Plain first, coloured when the highlighter is in: same text, same metrics (colours only). */}
      <pre className="octo-code overflow-x-auto font-mono text-xs leading-5">
        <code>
          <HighlightedCode code={code} lang={lang} />
        </code>
      </pre>
    </div>
  );
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const hastText = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(hastText).join(""));
const elements = (n: HastNode, tag: string): HastNode[] => (n.children ?? []).filter((c) => c.type === "element" && c.tagName === tag);
/** A cell that holds a number: 1,284 · €2,418,903.17 · 12% · 3.1k · −4 · 240ms (an empty cell or "—" passes). */
const NUMERIC = /^(?:[-+−]?[$€£]?\s?\d[\d,.\s]*(?:%|k|K|M|B|ms|s|x|×)?|—|–|-|)$/;

/**
 * Tables right-align numeric columns (every body cell a number) with tabular numerals: a rehype pass
 * that marks those cells `octo-num`.
 */
function rehypeNumericColumns() {
  return (tree: HastNode) => {
    const walk = (n: HastNode) => {
      if (n.type === "element" && n.tagName === "table") {
        const rows = [...elements(n, "thead"), ...elements(n, "tbody")].flatMap((g) => elements(g, "tr"));
        const body = elements(n, "tbody").flatMap((g) => elements(g, "tr"));
        const width = Math.max(0, ...rows.map((r) => [...elements(r, "td"), ...elements(r, "th")].length));
        for (let col = 0; col < width; col++) {
          const cells = body.map((r) => elements(r, "td")[col]).filter((c): c is HastNode => c !== undefined);
          const texts = cells.map((c) => hastText(c).trim());
          if (!texts.some((t) => /\d/.test(t)) || !texts.every((t) => NUMERIC.test(t))) continue;
          for (const r of rows) {
            const cell = [...elements(r, "th"), ...elements(r, "td")][col];
            if (cell) cell.properties = { ...cell.properties, className: [...((cell.properties?.className as string[] | undefined) ?? []), "octo-num"] };
          }
        }
        return;
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}
const REHYPE = [rehypeNumericColumns];

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const WITH_FILE_LINKS: Components = { ...COMPONENTS, code: ({ children }) => <InlineCode>{children}</InlineCode> };

export const Markdown = memo(function Markdown(props: {
  text: string;
  className?: string;
  streaming?: boolean;
  /** Assistant prose: inline code naming a project file links to it (decision 19). */
  fileLinks?: boolean;
  /** Overrides (the file preview's links and images). */
  components?: Components;
}) {
  const { text, className } = props;
  const base = props.fileLinks ? WITH_FILE_LINKS : COMPONENTS;
  return (
    <div className={className ?? "octo-prose"} data-streaming={props.streaming ? "" : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={REHYPE} components={props.components ? { ...base, ...props.components } : base}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
