import { Image } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { splitFrontMatter } from "../../lib/frontMatter";
import type { Components } from "react-markdown";
import { normalizePath, parentPath } from "../../lib/files";
import type { OpenFile } from "../../state/code";
import { useCode } from "../../state/code";
import { Markdown } from "../shared/Markdown";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

/**
 * Preview of a Markdown file: the chat's renderer on the conversation measure, centred, 32px above and
 * below (plus `bottomRoom` for a floating composer). It follows the buffer, so edits made in Source
 * show here. Relative links open the project file they point to (`#heading` links scroll to the
 * heading); images are never fetched — they show as their alt text.
 */
export function MarkdownPreview({ file, bottomRoom, onOpen }: { file: OpenFile; bottomRoom: number; onOpen(folder: string, path: string): void }) {
  const { buffers } = useCode();
  const [text, setText] = useState(() => buffers.value(file.key) ?? file.content);
  const root = useRef<HTMLDivElement>(null);
  const front = useMemo(() => splitFrontMatter(text), [text]);

  useEffect(() => {
    setText(buffers.value(file.key) ?? file.content);
    return buffers.onChange((key) => {
      if (key === file.key) setText(buffers.value(key) ?? file.content);
    });
  }, [buffers, file.key, file.content]);

  const components = useMemo<Components>(() => {
    const dir = parentPath(file.path);
    return {
      a: ({ children, href = "" }) => {
        const external = SCHEME.test(href) || href.startsWith("//");
        const onClick = (e: MouseEvent) => {
          if (external || e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          if (href.startsWith("#")) {
            let id = href.slice(1);
            try {
              id = decodeURIComponent(id);
            } catch {
              // Keep raw fragment if percent-encoding is malformed.
            }
            const target = [...(root.current?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [])].find((h) => slug(h.textContent ?? "") === id);
            target?.scrollIntoView({ block: "start" });
            return;
          }
          const clean = href.split(/[?#]/, 1)[0] ?? href;
          const path = normalizePath(clean.startsWith("/") ? clean : `${dir}/${clean}`);
          if (path) onOpen(file.folder, path);
        };
        return (
          <a
            href={href}
            onClick={onClick}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
            title={external ? href : `Open ${href}`}
          >
            {children}
          </a>
        );
      },
      img: ({ alt, src }) => (
        <span
          role="img"
          aria-label={alt || "Image"}
          title={`Images aren't loaded in the preview${typeof src === "string" && src ? `: ${src}` : ""}`}
          className="inline-flex h-6 max-w-full items-center gap-2 rounded-sm border border-line px-2 align-middle text-xs text-fg-3"
        >
          <Glyph icon={Image} size={14} className="shrink-0" />
          <span className="truncate">{alt || "Image"}</span>
        </span>
      ),
    };
  }, [file.folder, file.path, onOpen]);

  return (
    <div ref={root} data-md-preview data-file-focus tabIndex={-1} className="h-full min-h-0 overflow-y-auto focus-inset scroll-quiet">
      <div className="px-6">
        <article aria-label={`Preview of ${file.name}`} className="mx-auto w-full max-w-measure py-8">
          {front && front.fields.length > 0 && (
            // Front matter is metadata, not content: a quiet key / value block, not a rule and a heading.
            <dl aria-label="Front matter" className="mb-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-md border border-line px-3 py-2 text-xs">
              {front.fields.map(([k, v]) => (
                <Fragment key={k}>
                  <dt className="text-fg-3">{k}</dt>
                  <dd className="min-w-0 truncate text-fg-2" title={v}>
                    {v}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          <Markdown text={front ? front.body : text} components={components} className="octo-prose octo-doc" />
        </article>
        {/* Room for the floating composer: a spacer, so the padding stays on the scale. */}
        {bottomRoom > 0 && <div aria-hidden style={{ height: bottomRoom }} />}
      </div>
    </div>
  );
}
