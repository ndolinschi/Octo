import { Image } from "lucide-react";
import { useState, type ReactNode } from "react";
import { imageSource } from "../../lib/markdownImage";
import { Glyph } from "../primitives/Glyph";
import { InlineButton } from "../primitives/InlineButton";

/**
 * An image that is not shown: a compact chip with its alt text (the file preview's form, decision on untrusted
 * Markdown). `detail` says where it is from; `action` offers to load it.
 */
export function ImageChip({ alt, title, detail, action }: { alt: string | undefined; title: string; detail?: string; action?: ReactNode }) {
  return (
    // With an action it is a group (an `img` role would hide the button from assistive technology).
    <span
      role={action ? "group" : "img"}
      aria-label={alt || "Image"}
      title={title}
      className="inline-flex h-6 max-w-full items-center gap-2 rounded-sm border border-line px-2 align-middle text-xs text-fg-3"
    >
      <Glyph icon={Image} size={14} className="shrink-0" />
      <span className="truncate">{alt || "Image"}</span>
      {detail && <span className="shrink-0 text-fg-3">· {detail}</span>}
      {action}
    </span>
  );
}

/**
 * A Markdown image in text an agent or a person wrote. A remote one is never fetched by itself (the request alone
 * would carry whatever the URL holds out of the computer): it waits as a chip naming its host, and loads, without a
 * referrer, only on "Load image". Inline and local images render as before; any other scheme never loads.
 */
export function MarkdownImage({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const source = imageSource(src);
  const [load, setLoad] = useState(false);
  if (source.kind === "inline" || (source.kind === "remote" && load)) {
    return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" className="max-w-full" />;
  }
  if (source.kind === "remote") {
    return (
      <ImageChip
        alt={alt}
        title={`Not loaded: images from other sites load only when you ask (${source.host})`}
        detail={source.host}
        action={
          <InlineButton onPress={() => setLoad(true)} className="shrink-0 text-link hover:underline">
            Load image
          </InlineButton>
        }
      />
    );
  }
  return <ImageChip alt={alt} title="This image is not loaded" />;
}
