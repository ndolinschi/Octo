import type { Bridge } from "@octo/agent-client";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { errorMessage } from "../../lib/format";
import { room } from "../../lib/images";

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

/** What `useImages` lends the first-use code: its state setters, refs and the bridge. */
export type ImageSink = {
  bridge: Bridge;
  projectId: string;
  count: RefObject<number>;
  urls: RefObject<Set<string>>;
  setImages: Dispatch<SetStateAction<ImageChip[]>>;
  setNote(note: string | null): void;
  patch(id: string, change: Partial<ImageChip>): void;
};

let nextId = 0;

/**
 * B12: adding pictures to the message being written (`useImages`), loaded with the first one: each is shown at once as a chip,
 * scaled in the browser (`prepareImage`) and uploaded in the background.
 */
export function addImages(files: readonly File[], sink: ImageSink): void {
  const { bridge, projectId, count, urls, setImages, setNote, patch } = sink;
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
}
