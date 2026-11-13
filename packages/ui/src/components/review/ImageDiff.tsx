import { useEffect, useState } from "react";
import type { ReviewFile } from "@octo/agent-client";
import { sizeChange } from "../../lib/review/files";

/** An image file: before and after side by side (or the one that exists), straight from the raw endpoint. */
export function ImageDiff({ file, rawUrl }: { file: ReviewFile; rawUrl(side: "new" | "old"): string }) {
  const sides = [
    ...(file.old_size >= 0 ? [{ side: "old" as const, label: "Before" }] : []),
    ...(file.new_size >= 0 ? [{ side: "new" as const, label: "After" }] : []),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <p className="mb-3 text-xs text-fg-3">
        {file.status === "added" ? "New image" : file.status === "deleted" ? "Removed image" : "Changed image"}: {sizeChange(file)}
      </p>
      <div className="flex flex-wrap items-start gap-3">
        {sides.map((s) => (
          <Figure key={s.side} label={s.label} src={rawUrl(s.side)} />
        ))}
      </div>
    </div>
  );
}

function Figure({ label, src }: { label: string; src: string }) {
  const [failed, setFailed] = useState(false);
  // Probe the address off-screen, so a broken image says so in words instead of showing a broken-image icon.
  useEffect(() => {
    const probe = new Image();
    probe.onerror = () => setFailed(true);
    probe.src = src;
    return () => {
      probe.onerror = null;
    };
  }, [src]);
  return (
    <figure className="flex min-w-0 flex-1 basis-60 flex-col gap-2">
      <figcaption className="text-xs text-fg-2">{label}</figcaption>
      <div className="grid min-h-24 place-items-center rounded-md border border-line bg-code-bg p-2">
        {failed ? (
          <span role="alert" className="text-xs text-err">
            The image did not load.
          </span>
        ) : (
          <img src={src} alt={label} className="max-h-80 max-w-full object-contain" />
        )}
      </div>
    </figure>
  );
}
