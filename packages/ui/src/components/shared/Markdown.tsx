import { Check, Copy } from "lucide-react";
import { Button } from "../primitives/Button";
import { memo, Suspense, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopy, useScrollFade } from "../../lib/hooks";
import { InlineCode } from "./FileLink";
import { readyLazy } from "../../lib/readyLazy";
import { MarkdownImage } from "./MarkdownImage";
import { NUMERIC_CELL } from "../../lib/numericCell";
import { remarkSoftBreaks } from "../../lib/softBreaks";

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
  const pre = useRef<HTMLPreElement>(null);
  useScrollFade(pre, "x");
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = pre.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [code]);
  return (
    // Card inset 12 on all sides: a 20px caption row, 8 below it, then 20px code lines.
    <div className="octo-code-surface my-3 overflow-hidden p-card">
      <div className="mb-2 flex h-5 items-center">
        <span className="font-mono text-xs text-fg-3">{lang ?? "text"}</span>
        <Button variant="quiet" size="xs" icon={copied ? Check : Copy} onClick={() => copy(code)} className="-my-0.5 -mr-2 ml-auto">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* Plain first, coloured when the highlighter is in: same text, same metrics (colours only). */}
      {/* 7f: a block that scrolls sideways is a named stop in the tab order, so the keyboard can scroll it (WebKit does not
          focus a scroller by itself); one that fits is not. */}
      <pre
        ref={pre}
        className="octo-code overflow-x-auto rounded-xs fade-x font-mono text-xs leading-5 focus-inset"
        {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": `Code, ${lang ?? "text"}` } : {})}
      >
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
          if (!texts.some((t) => /\d/.test(t)) || !texts.every((t) => NUMERIC_CELL.test(t))) continue;
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
/** P2-13: single newlines are line breaks in paragraphs that read as lines, spaces in hard-wrapped prose (lib/softBreaks). */
const REMARK = [remarkGfm, remarkSoftBreaks];

/** Decision 99: fetched with this chunk and rendered without suspending once in, so a table is framed in its first frame. */
const tableFrame = readyLazy(() => import("./DataTable").then((m) => m.TableFrame));
void tableFrame.fetch().catch(() => undefined);
const TableFrame = tableFrame.Component;

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Decision 44's frame loads with the first table (its own chunk); the same table renders plain until then.
  table: ({ children }) => (
    <Suspense
      fallback={
        <div className="octo-table-frame">
          <div className="octo-table-scroll">
            <table className="octo-table">{children}</table>
          </div>
        </div>
      }
    >
      <TableFrame>{children}</TableFrame>
    </Suspense>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // A remote image waits for "Load image" (its URL alone could carry data out); overrides may replace it.
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

const WITH_FILE_LINKS: Components = { ...COMPONENTS, code: ({ children }) => <InlineCode>{children}</InlineCode> };

import { splitStableMarkdown } from "../../lib/markdownSplit";

/** Settled texts whose rendering is kept, most recently used last. */
const KEPT_MAX = 400;
const kept = new WeakMap<Components, Map<string, ReactElement>>();

/**
 * The rendered Markdown of a settled text, kept across remounts: a long conversation unmounts the turns far from the
 * viewport and mounts them again as the reader scrolls back, and parsing their Markdown again was most of each remount.
 * `react-markdown`'s `Markdown` is synchronous and uses no hooks, so its element tree can be made once and reused.
 */
function renderKept(text: string, components: Components): ReactElement {
  let byText = kept.get(components);
  if (!byText) kept.set(components, (byText = new Map<string, ReactElement>()));
  const hit = byText.get(text);
  if (hit) {
    byText.delete(text);
    byText.set(text, hit);
    return hit;
  }
  const el = ReactMarkdown({ children: text, remarkPlugins: REMARK, rehypePlugins: REHYPE, components });
  byText.set(text, el);
  if (byText.size > KEPT_MAX) byText.delete(byText.keys().next().value ?? "");
  return el;
}

/** `keep`: the text is settled (not a streaming tail, which changes with every token). */
const MarkdownChunk = memo(function MarkdownChunk({ text, components, keep = true }: { text: string; components: Components; keep?: boolean }) {
  if (keep) return renderKept(text, components);
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown(props: {
  text: string;
  className?: string;
  streaming?: boolean;
  /** Assistant prose: inline code naming a project file links to it (decision 19). */
  fileLinks?: boolean;
  /** Overrides (the file preview's links and images). */
  components?: Components;
}) {
  const { text, className, streaming, fileLinks, components: overrides } = props;
  const base = fileLinks ? WITH_FILE_LINKS : COMPONENTS;
  const resolved = useMemo(() => (overrides ? { ...base, ...overrides } : base), [base, overrides]);
  const parts = useMemo(() => (streaming ? splitStableMarkdown(text) : null), [streaming, text]);

  return (
    <div className={className ?? "octo-prose"} data-streaming={streaming ? "" : undefined}>
      {parts && parts.stable.length > 0 ? (
        <>
          {parts.stable.map((chunk, i) => (
            <MarkdownChunk key={i} text={chunk} components={resolved} />
          ))}
          {parts.tail && <MarkdownChunk text={parts.tail} components={resolved} keep={false} />}
        </>
      ) : (
        <MarkdownChunk text={text} components={resolved} keep={!streaming} />
      )}
    </div>
  );
});
