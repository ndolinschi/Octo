import { ArrowLeft, ArrowRight, Monitor, MousePointerClick, Plus, RotateCw, Send, Smartphone, Tablet } from "lucide-react";
import { useId, useRef, useState, type SyntheticEvent } from "react";
import { cn } from "../../lib/cn";
import type { DesignNote } from "../../lib/browser/designNotes";
import type { BrowserViewport } from "../../state/browserTabs";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { TextField } from "../primitives/TextField";
import { PendingNotesPopover } from "./PendingNotesPopover";

export const VIEWPORT_LABEL: Record<BrowserViewport, string> = {
  full: "Full width",
  desktop: "Desktop (1280px)",
  tablet: "Tablet (768px)",
  mobile: "Mobile (390px)",
};

export function BrowserToolbar(props: {
  url: string;
  viewport: BrowserViewport;
  designMode: boolean;
  sending: boolean;
  pendingNotes: readonly DesignNote[];
  canOpenNewTab: boolean;
  onNavigate(action: "back" | "forward"): void;
  onReload(): void;
  onSubmitUrl(raw: string): boolean;
  onViewportChange(next: BrowserViewport): void;
  onOpenNewTab(): void;
  onToggleDesign(): void;
  onSelectPin(note: DesignNote): void;
  onRemovePin(noteId: string): void;
  onClearPins(): void;
  onSendBatch(): void;
}) {
  const urlId = useId();
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [vpMenu, setVpMenu] = useState<{ x: number; y: number } | null>(null);
  const vpBtnRef = useRef<HTMLButtonElement>(null);

  const shownUrl = draftUrl ?? props.url;

  const onSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (props.onSubmitUrl(shownUrl)) {
      setDraftUrl(null);
      setInvalid(false);
      // Navigation has started: the field lets go of focus, so its ring does not stay on a finished entry.
      const field = document.activeElement;
      if (field instanceof HTMLElement && e.currentTarget.contains(field)) field.blur();
    } else {
      setInvalid(true);
    }
  };

  const vpIcon = props.viewport === "mobile" ? Smartphone : props.viewport === "tablet" ? Tablet : Monitor;
  const vpItems: MenuItem[] = (["full", "desktop", "tablet", "mobile"] as const).map((vp) => ({
    id: vp,
    label: VIEWPORT_LABEL[vp],
    checked: props.viewport === vp,
    run: () => props.onViewportChange(vp),
  }));

  return (
    <header className="@container/bt flex h-ctl-lg shrink-0 items-center gap-1.5 px-pane shadow-[inset_0_-1px_0_var(--octo-line)]">
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={ArrowLeft} label="Back" size="sm" disabled={!props.url} onClick={() => props.onNavigate("back")} />
        <IconButton
          icon={ArrowRight}
          label="Forward"
          size="sm"
          disabled={!props.url}
          className="@max-[500px]/bt:hidden"
          onClick={() => props.onNavigate("forward")}
        />
        <IconButton icon={RotateCw} label="Reload" size="sm" disabled={!props.url} onClick={props.onReload} />
      </div>

      <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center">
        <label htmlFor={urlId} className="touch-hit flex w-full items-center">
          <span className="sr-only">Page URL</span>
          <TextField
            id={urlId}
            size="sm"
            touchSize="sm"
            aria-label="Page URL"
            {...(invalid ? { "aria-invalid": true } : {})}
            value={shownUrl}
            onChange={(e) => {
              setDraftUrl(e.target.value);
              if (invalid) setInvalid(false);
            }}
            onBlur={() => {
              if (draftUrl !== null && draftUrl.trim() === props.url) setDraftUrl(null);
            }}
            placeholder="http://localhost:5173 or https://…"
            className="font-mono text-xs touch:text-input-touch"
          />
        </label>
      </form>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          ref={vpBtnRef}
          icon={vpIcon}
          label={`Viewport: ${VIEWPORT_LABEL[props.viewport]}`}
          size="sm"
          pressed={props.viewport !== "full"}
          className={cn(props.viewport === "full" && "@max-[500px]/bt:hidden")}
          onClick={() => {
            const r = vpBtnRef.current?.getBoundingClientRect();
            if (r) setVpMenu(vpMenu ? null : { x: r.right, y: r.bottom + 4 });
          }}
        />
        {props.canOpenNewTab && <IconButton icon={Plus} label="New browser tab" size="sm" className="@max-[500px]/bt:hidden" onClick={props.onOpenNewTab} />}
        <Button
          variant={props.designMode ? "secondary" : "quiet"}
          size="sm"
          icon={MousePointerClick}
          pressed={props.designMode}
          title={`Toggle design mode (${MOD}⇧D)`}
          disabled={!props.url}
          data-design-toggle
          className="@max-[500px]/bt:gap-0 @max-[500px]/bt:px-2"
          onClick={props.onToggleDesign}
        >
          <span className="@max-[500px]/bt:sr-only">Design</span>
        </Button>
        <PendingNotesPopover notes={props.pendingNotes} onSelect={props.onSelectPin} onRemove={props.onRemovePin} onClearAll={props.onClearPins} />
        {props.pendingNotes.length > 0 && (
          <Button variant="primary" size="sm" icon={Send} loading={props.sending} data-send-batch onClick={props.onSendBatch}>
            {`Send (${props.pendingNotes.length})`}
          </Button>
        )}
      </div>

      <Presence show={vpMenu !== null} exitMs={0}>
        {vpMenu && <Menu label="Viewport size" x={vpMenu.x} y={vpMenu.y} alignEnd ignoreRef={vpBtnRef} items={vpItems} onClose={() => setVpMenu(null)} />}
      </Presence>
    </header>
  );
}
