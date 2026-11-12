import type { ContentBlock } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Presence } from "../primitives/Presence";
import { Skeleton } from "../primitives/Skeleton";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

export type ImageBlock = Extract<ContentBlock, { type: "image" }>;

/** One attachment's bytes as an object URL (fetched once, revoked when the thumbnail goes); null while loading or after a failure. */
function useAttachmentUrl(id: string): { url: string | null; failed: boolean } {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    if (!bridge.fetchAttachment) {
      setState({ url: null, failed: true });
      return;
    }
    bridge.fetchAttachment(projectId, id).then(
      (res) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([res.data], { type: res.type }));
        setState({ url: made, failed: false });
      },
      () => alive && setState({ url: null, failed: true }),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [bridge, projectId, id]);
  return state;
}

/** The images a user message carried (B12): thumbnails that open a preview. */
export function PromptImages({ blocks }: { blocks: ImageBlock[] }) {
  const [open, setOpen] = useState<ImageBlock | null>(null);
  return (
    <>
      <ul data-prompt-images aria-label="Attached images" className="mt-2 flex flex-wrap gap-2">
        {blocks.map((b) => (
          <li key={b.attachment_id}>
            <Thumb block={b} onOpen={() => setOpen(b)} />
          </li>
        ))}
      </ul>
      <Presence show={open !== null}>
        {open && (
          <Dialog title={open.name ?? "Image"} description={`${open.width} × ${open.height}`} width="lg" onClose={() => setOpen(null)}>
            <Preview block={open} />
          </Dialog>
        )}
      </Presence>
    </>
  );
}

function Thumb({ block, onOpen }: { block: ImageBlock; onOpen(): void }) {
  const { url, failed } = useAttachmentUrl(block.attachment_id);
  const label = `${block.name ?? "Image"}, ${block.width} by ${block.height}`;
  if (failed) return <span className="text-xs text-fg-3">{block.name ?? "Image"} could not be loaded</span>;
  return (
    <Button variant="quiet" size="lg" aria-label={`Open ${label}`} title={label} onClick={onOpen} disabled={url === null} className="h-auto p-0">
      {url ? (
        <img src={url} alt="" className="max-h-24 max-w-40 rounded-sm border border-line object-cover" />
      ) : (
        <Skeleton shape="block" className="h-20 w-28" />
      )}
    </Button>
  );
}

function Preview({ block }: { block: ImageBlock }) {
  const { url, failed } = useAttachmentUrl(block.attachment_id);
  if (failed) return <p className="text-sm text-fg-2">The image could not be loaded.</p>;
  if (!url) return <Skeleton shape="block" className="h-64 w-full" />;
  return <img src={url} alt={block.name ?? "Attached image"} className="mx-auto max-h-[70vh] max-w-full rounded-sm object-contain" />;
}
