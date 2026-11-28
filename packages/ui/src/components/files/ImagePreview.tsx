import { fileBytesReader } from "@octo/agent-client";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { errorCode, errorMessage } from "../../lib/format";
import { useDelayedLoading } from "../../lib/hooksMore";
import { fileSizeLabel, imageDataUrl, pixelSizeLabel } from "../../lib/imagePreview";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Segmented } from "../primitives/Segmented";
import { Spinner } from "../primitives/Status";

type Load = { status: "loading" } | { status: "ready"; url: string; size: number } | { status: "too_large" } | { status: "error"; message: string };
type Zoom = "fit" | "actual";

/**
 * An image in the Files view (walk B15): the picture centred on the panel, its pixel size and file size under it, fitted
 * to the pane (never enlarged) with a 100 % switch. The bytes come from the bridge's optional byte read; a bridge without
 * one shows `fallback` (the binary notice). SVG is drawn through an `<img>` with a data URL, so its scripts never run.
 */
export function ImagePreview(props: {
  projectId: string;
  folder: string;
  path: string;
  workspaceId?: string | undefined;
  /** The size the tree listed, for "Too large to preview" (the refusal carries none). */
  sizeHint: number | undefined;
  /** An SVG already open as text: drawn from this text (unsaved edits included), nothing is fetched. */
  svgText?: string;
  /** Room reserved at the bottom for the floating composer; when set, the meta/zoom bar sits at the top so it is never covered. */
  bottomRoom?: number;
  fallback: ReactNode;
  actions: ReactNode;
}) {
  const { bridge } = useApp();
  const canRead = fileBytesReader(bridge) !== undefined;
  // The caller keys this by file, so a new file starts from "loading" without an effect resetting it.
  const { projectId, folder, path, workspaceId, svgText } = props;
  const [fetched, setLoad] = useState<Load>({ status: "loading" });
  const fromText = svgText !== undefined;
  const load: Load = svgText === undefined ? fetched : { status: "ready", url: svgTextUrl(svgText), size: new TextEncoder().encode(svgText).length };
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const slow = useDelayedLoading(load.status === "loading");
  const name = path.slice(path.lastIndexOf("/") + 1);

  useEffect(() => {
    const read = fileBytesReader(bridge);
    if (!read || fromText) return;
    let live = true;
    read(projectId, folder, path, workspaceId ? { workspaceId } : undefined).then(
      (b) => live && setLoad({ status: "ready", url: imageDataUrl(path, b.content), size: b.size }),
      (e: unknown) => live && setLoad(errorCode(e) === "file_too_large" ? { status: "too_large" } : { status: "error", message: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [bridge, projectId, folder, path, workspaceId, attempt, fromText]);

  // The pixel size, read from the decoded picture (not from an event on the <img>).
  const url = load.status === "ready" ? load.url : null;
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.src = url;
    img.decode().then(
      () => live && setNatural({ w: img.naturalWidth, h: img.naturalHeight }),
      // An image the browser cannot decode shows its broken <img>; the meta line then gives the file size alone.
      () => live && setNatural({ w: 0, h: 0 }),
    );
    return () => {
      live = false;
    };
  }, [url]);

  if (!canRead && !fromText) return <>{props.fallback}</>;
  if (load.status === "too_large") {
    return (
      <Frame>
        <EmptyState title="Too large to preview" actions={props.actions}>
          {props.sizeHint !== undefined ? `${name} is ${fileSizeLabel(props.sizeHint)}; the limit is 2 MB.` : `${name} is larger than 2 MB.`}
        </EmptyState>
      </Frame>
    );
  }
  if (load.status === "error") {
    return (
      <Frame>
        <EmptyState
          title={`Couldn't show ${name}`}
          tone="err"
          actions={
            <span className="flex flex-wrap items-center justify-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setLoad({ status: "loading" });
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </Button>
              {props.actions}
            </span>
          }
        >
          {load.message.replace(/\.$/, "")}.
        </EmptyState>
      </Frame>
    );
  }
  const pixels = pixelSizeLabel(natural.w, natural.h);
  const bottomRoom = props.bottomRoom ?? 0;
  const bar = (
    <div
      className={cn(
        "flex h-ctl-lg shrink-0 items-center gap-3 pr-pane pl-4 text-xs text-fg-3 tabular-nums",
        bottomRoom > 0 ? "shadow-[inset_0_-1px_0_var(--octo-line)]" : "shadow-[inset_0_1px_0_var(--octo-line)]",
      )}
    >
      <span className="min-w-0 flex-1 truncate" role="status">
        {load.status === "ready" ? [pixels, fileSizeLabel(load.size)].filter(Boolean).join(" · ") : ""}
      </span>
      <Segmented<Zoom>
        label="Image size"
        options={[
          { id: "fit", label: "Fit" },
          { id: "actual", label: "100 %" },
        ]}
        value={zoom}
        onChange={setZoom}
      />
    </div>
  );
  return (
    <Frame>
      {bottomRoom > 0 && bar}
      {/* Auto margins centre the picture while it fits and let it scroll from its edge when it does not (100 %). */}
      <div data-image-preview className="flex min-h-0 flex-1 overflow-auto p-4">
        {load.status === "ready" ? (
          <img
            key={load.url}
            src={load.url}
            alt={name}
            draggable={false}
            className={cn("m-auto block shrink-0", zoom === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none")}
          />
        ) : (
          slow && (
            <p role="status" className="flex items-center gap-2 text-sm text-fg-3">
              <Spinner size="xs" /> Loading {name}…
            </p>
          )
        )}
      </div>
      {bottomRoom > 0 ? <div aria-hidden className="shrink-0" style={{ height: bottomRoom }} /> : bar}
    </Frame>
  );
}

/** SVG text as an `<img>` source: the markup never enters the document, so its scripts cannot run. */
function svgTextUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}
