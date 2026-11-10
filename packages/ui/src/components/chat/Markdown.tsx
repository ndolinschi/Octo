import { Check, Copy } from "lucide-react";
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopy } from "../../lib/hooks";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, copy] = useCopy();
  const child = Array.isArray(children) ? children[0] : children;
  const className =
    child && typeof child === "object" && "props" in child
      ? ((child as { props: { className?: string } }).props.className ?? "")
      : "";
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
          className="press -my-0.5 -mr-2 ml-auto inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg"
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto font-mono text-xs leading-5 text-fg">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown(props: { text: string; className?: string; streaming?: boolean }) {
  const { text, className } = props;
  return (
    <div className={className ?? "octo-prose"} data-streaming={props.streaming ? "" : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
