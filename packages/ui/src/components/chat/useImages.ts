import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { room } from "../../lib/images";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

export type ImageChip = {
  id: string;
  name: string;
  bytes: number;
  /** An object URL of the (possibly scaled) picture, for the thumbnail. */
  url: string;
  state: "working" | "ready" | "failed";
  attachmentId?: string;
  problem?: string;
};

let nextId = 0;

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
      const { take, over } = room(count.current, files.length);
      setNote(over > 0 ? `Only 8 images go with one message; ${over} ${over === 1 ? "was" : "were"} left out.` : null);
      count.current += take;
      for (const file of files.slice(0, take)) {
        const id = `img${(nextId += 1)}`;
        const url = URL.createObjectURL(file);
        urls.current.add(url);
        setImages((cur) => [...cur, { id, name: file.name || "image", bytes: file.size, url, state: "working" }]);
        void (async () => {
          try {
            const { prepare } = await import("./prepareImage");
            const { blob, name } = await prepare(file);
            const shown = URL.createObjectURL(blob);
            urls.current.add(shown);
            patch(id, { url: shown, bytes: blob.size, name });
            if (!bridge.uploadAttachment) throw new Error("This harness cannot take images");
            const att = await bridge.uploadAttachment(projectId, new Uint8Array(await blob.arrayBuffer()), { name });
            patch(id, { state: "ready", attachmentId: att.id });
          } catch (e) {
            patch(id, { state: "failed", problem: errorMessage(e) });
          }
        })();
      }
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
