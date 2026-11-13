import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

export type { ImageChip } from "./addImages";
import type { ImageChip } from "./addImages";

/**
 * B12: the images of the message being written. Each is scaled in the browser (`lib/images`), shown at once as a chip with a
 * thumbnail and its size, and uploaded in the background (`uploadAttachment`); sending carries the ids of the ready ones.
 */
export function useImages() {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [images, setImages] = useState<ImageChip[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const urls = useRef(new Set<string>());
  const count = useRef(0);
  count.current = images.length;

  useEffect(() => {
    const all = urls.current;
    return () => {
      for (const u of all) URL.revokeObjectURL(u);
      all.clear();
    };
  }, []);

  const patch = useCallback((id: string, change: Partial<ImageChip>) => setImages((cur) => cur.map((i) => (i.id === id ? { ...i, ...change } : i))), []);

  const add = useCallback(
    (files: readonly File[]) => {
      // The work of adding pictures loads with the first one (its own chunk).
      void import("./addImages").then(
        (m) => m.addImages(files, { bridge, projectId, count, urls, setImages, setNote, patch }),
        (e: unknown) => setNote(`Couldn't add the images: ${errorMessage(e)}. Try again.`),
      );
    },
    [bridge, projectId, patch],
  );

  const remove = useCallback((id: string) => setImages((cur) => cur.filter((i) => i.id !== id)), []);
  const clear = useCallback(() => {
    setImages([]);
    setNote(null);
  }, []);
  const ready = images.flatMap((i) => (i.state === "ready" && i.attachmentId ? [i.attachmentId] : []));
  const busy = images.some((i) => i.state === "working");
  return { images, note, dismissNote: () => setNote(null), add, remove, clear, ready, busy };
}
