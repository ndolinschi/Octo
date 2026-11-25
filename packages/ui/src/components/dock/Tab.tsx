import { X } from "lucide-react";
import { memo, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
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
 * tooltip); a short strip shrinks tabs evenly down to their floor (C2: the whole title, or `TAB_FLOOR` for a long one); what does not fit goes to "All tabs". The close place
 * is reserved, so hover and state changes never move anything; decision 90: in a short strip an inactive tab gives the place up
 * and its close button shows over the end of the title on hover and focus, still without a width change.
 */
export const Tab = memo(function Tab(props: {
  tab: TabId;
  info: TabInfo;
  selected: boolean;
  focusedGroup: boolean;
  /** Live displacement while a drag makes room (px), or the dragged tab's own offset. */
  shift: number;
  /** The strip is short (decision 90): an inactive tab keeps no close place; its close button shows over the end of the title. */
  overlayClose: boolean;
  /** C2: the narrowest it is drawn (its whole title and close place, or `TAB_FLOOR` for a long title); TAB_MIN by default. */
  minWidth?: number;
  /** Whether this tab can be closed right now (defaults to `closable(tab)`). */
  canClose?: boolean;
  dragging: "self-attached" | "self-detached" | "other" | null;
  onPress(e: PointerEvent): void;
  onClose(): void;
  /** Double-click: maximise or restore the tab's group (decision 78). */
  onMaximise(): void;
  onMenu(x: number, y: number): void;
  onKeyDown(e: KeyboardEvent): void;
}) {
  const { tab, info, selected } = props;
  const canClose = props.canClose ?? closable(tab);
  const name = info.name ?? info.label;
  const hasTrailing = canClose || info.status === "modified";
  const slot = !props.overlayClose || selected || info.status === "modified";
  const style: CSSProperties = { maxWidth: TAB_MAX, minWidth: props.minWidth ?? TAB_MIN };
  if (props.shift) style.transform = `translateX(${props.shift}px)`;
  return (
    <div
      data-tab-wrapper
      role="none"
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
        "group/tab relative flex h-ctl-sm w-max shrink items-center rounded-sm press-row",
        selected
          ? props.focusedGroup
            ? "bg-tab-active text-fg shadow-tab"
            : "bg-tab-active/70 text-fg-2 hover:bg-tab-active hover:text-fg"
          : "text-fg-3 hover:bg-hover hover:text-fg-2",
        // Neighbours slide out of the way (`--motion-base`); the dragged tab follows the pointer.
        props.dragging === "other" && "motion-safe:transition-transform motion-safe:duration-base motion-safe:ease-out-quint",
        props.dragging === "self-attached" && "z-10 bg-tab-active text-fg shadow-pop",
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
        // 11a: the close button is out of the tablist's a11y (aria-hidden): the keyboard's way is Ctrl/Cmd+W on the tab.
        aria-keyshortcuts={canClose ? "Control+W Meta+W" : undefined}
        tabIndex={selected ? 0 : -1}
        title={info.title}
        aria-description={commentsDescription(info.comments)}
        onKeyDown={props.onKeyDown}
        className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-sm focus-inset", hasTrailing && slot && "pr-1")}
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {info.glyph ? <StateGlyph state={info.glyph} /> : <Glyph icon={info.icon} size={14} />}
        </span>
        {/* Polish step 2 (F3): the active tab's title is medium weight. The `::after` holds the same text in that weight, invisible
            and 0px tall, so every tab is always as wide as its medium-weight title: selecting a tab never changes a width (83). */}
        <span
          data-tab-label
          data-bold={info.detail ? `${info.label} / ${info.detail}` : info.label}
          aria-hidden={info.name ? true : undefined}
          className={cn(
            "flex min-w-0 flex-col overflow-hidden after:invisible after:h-0 after:font-medium after:whitespace-nowrap after:content-[attr(data-bold)]",
            !slot && canClose && "group-focus-within/tab:tab-close-fade group-hover/tab:tab-close-fade",
          )}
        >
          <span className={cn("min-w-0 truncate", selected && "font-medium")}>
            {info.label}
            {info.detail && <span className={cn("font-normal", selected ? "text-fg-2" : "text-fg-3")}> / {info.detail}</span>}
          </span>
        </span>
        {info.name && <span className="sr-only">{info.name}</span>}
        {info.comments > 0 && <CommentCount count={info.comments} />}
        {info.status === "modified" && <span className="sr-only"> (unsaved)</span>}
        {info.status === "running" && <span className="sr-only"> (working)</span>}
        {info.glyph === "failed" && <span className="sr-only"> (failed)</span>}
        {info.glyph === "needs" && <span className="sr-only"> (needs you)</span>}
      </button>
      {hasTrailing && (
        <span role="none" className={cn("relative grid shrink-0 place-items-center", slot ? "mr-1.5 size-4" : "absolute top-0 right-0 h-full w-0")}>
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
              aria-hidden="true"
              label={`Close ${name}`}
              data-shortcut={`${MOD}W`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={props.onClose}
              className={cn(
                // A 24px hit area around the 16px slot (decision 36); without a slot it sits over the faded title end.
                slot ? "absolute -inset-1" : "absolute top-1/2 right-1 -translate-y-1/2",
                selected && info.status !== "modified"
                  ? ""
                  : "pointer-events-none opacity-0 transition-opacity duration-fast group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100",
              )}
            />
          )}
        </span>
      )}
    </div>
  );
});
