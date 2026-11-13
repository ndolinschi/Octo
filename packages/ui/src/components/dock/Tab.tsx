import { X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { cn } from "../../lib/cn";
import { closable, type TabId } from "../../state/workspace/layout";
import { domId } from "../../state/workspace/ids";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { StateGlyph } from "../primitives/StateGlyph";
import { CommentCount, commentsDescription } from "../files/CommentCount";
import { TAB_MAX, TAB_MIN } from "../../state/workspace/tabStrip";
import type { TabInfo } from "./tabInfo";

/**
 * One tab (decision 25). 28px, radius 6; 8 [16px leading slot] 8 [label] 8 … [16px trailing slot] 8. The leading slot
 * holds the kind icon, or the state ring for an Orchestrator / Agent tab that is not idle (decision 29). The trailing
 * slot holds the unsaved dot and the close button, which shows on hover, focus and the active tab only (24px hit area).
 * Decision 83: the width is the content's (icon, title, close, insets) up to `TAB_MAX`, the title truncating (full name in the
 * tooltip); a short strip shrinks tabs evenly down to `TAB_MIN` (never fewer than four characters of the title). The close place
 * is reserved, so hover and state changes never move anything; decision 90: in a short strip an inactive tab gives the place up
 * and its close button shows over the end of the title on hover and focus, still without a width change.
 */
export function Tab(props: {
  tab: TabId;
  info: TabInfo;
  selected: boolean;
  focusedGroup: boolean;
  /** Live displacement while a drag makes room (px), or the dragged tab's own offset. */
  shift: number;
  /** The strip is short (decision 90): an inactive tab keeps no close place; its close button shows over the end of the title. */
  overlayClose: boolean;
  dragging: "self-attached" | "self-detached" | "other" | null;
  onPress(e: PointerEvent): void;
  onClose(): void;
  /** Double-click: maximise or restore the tab's group (decision 78). */
  onMaximise(): void;
  onMenu(x: number, y: number): void;
  onKeyDown(e: KeyboardEvent): void;
}) {
  const { tab, info, selected } = props;
  const canClose = closable(tab);
  const name = info.name ?? info.label;
  const slot = !props.overlayClose || selected || info.status === "modified";
  const style: CSSProperties = { maxWidth: TAB_MAX, minWidth: TAB_MIN };
  if (props.shift) style.transform = `translateX(${props.shift}px)`;
  return (
    <div
      data-tab-wrapper
      data-no-drag
      data-pinned={canClose ? undefined : ""}
      onPointerDown={props.onPress}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && canClose) {
          e.preventDefault();
          props.onClose();
        }
      }}
      onDoubleClick={props.onMaximise}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      style={style}
      className={cn(
        "group/tab relative flex h-row w-max shrink items-center rounded-sm press-row",
        selected ? (props.focusedGroup ? "bg-active text-fg" : "bg-hover text-fg") : "text-fg-3 hover:bg-hover hover:text-fg-2",
        // Neighbours slide out of the way (150ms); open/close changes widths (120ms); the dragged tab follows the pointer.
        props.dragging === "other" && "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-(--ease-out-quint)",
        props.dragging === "self-attached" && "z-10 bg-active text-fg shadow-pop",
        props.dragging === "self-detached" && "opacity-40",
      )}
    >
      <button
        type="button"
        role="tab"
        id={`${domId(tab)}-tab`}
        data-tab-id={tab}
        data-label={name}
        aria-selected={selected}
        aria-controls={`${domId(tab)}-panel`}
        tabIndex={selected ? 0 : -1}
        title={info.title}
        aria-description={commentsDescription(info.comments)}
        onKeyDown={props.onKeyDown}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-sm focus-inset"
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {info.glyph ? <StateGlyph state={info.glyph} /> : <Glyph icon={info.icon} size={14} />}
        </span>
        <span data-tab-label className="min-w-0 truncate" aria-hidden={info.name ? true : undefined}>
          {info.label}
          {info.detail && <span className="text-fg-3"> / {info.detail}</span>}
        </span>
        {info.name && <span className="sr-only">{info.name}</span>}
        {info.comments > 0 && <CommentCount count={info.comments} />}
        {info.status === "modified" && <span className="sr-only"> (unsaved)</span>}
        {info.status === "running" && <span className="sr-only"> (working)</span>}
        {info.glyph === "failed" && <span className="sr-only"> (failed)</span>}
        {info.glyph === "needs" && <span className="sr-only"> (needs you)</span>}
      </button>
      <span className={cn("relative grid shrink-0 place-items-center", slot ? "mr-2 size-4" : "absolute top-0 right-0 h-full w-0")}>
        {info.status === "modified" && (
          <span
            aria-hidden
            data-testid="modified-dot"
            className={cn("size-1.5 rounded-full bg-fg-2", canClose && "group-focus-within/tab:invisible group-hover/tab:invisible")}
          />
        )}
        {canClose && (
          <IconButton
            icon={X}
            size="xs"
            tabIndex={-1}
            label={`Close ${name}`}
            data-shortcut={`${MOD}W`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={props.onClose}
            className={cn(
              // A 24px hit area around the 16px slot (decision 36); without a slot it sits over the title's end on the tab's own fill.
              slot ? "absolute -inset-1" : "absolute top-1/2 right-1 -translate-y-1/2 bg-hover",
              selected && info.status !== "modified" ? "" : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100",
            )}
          />
        )}
      </span>
    </div>
  );
}
