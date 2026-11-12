import { X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { cn } from "../../lib/cn";
import { closable, type TabId } from "../../state/workspace/layout";
import { domId } from "../../state/workspace/ids";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";
import { StateGlyph } from "../primitives/StateGlyph";
import { CommentCount, commentsDescription } from "../files/CommentCount";
import type { TabInfo } from "./tabInfo";

/**
 * One tab (decision 25). 28px, radius 6; 8 [16px leading slot] 8 [label] 8 … [16px trailing slot] 8. The leading slot
 * holds the kind icon, or the state ring for an Orchestrator / Agent tab that is not idle (decision 29). The trailing
 * slot holds the unsaved dot and the close button, which shows on hover, focus and the active tab only (24px hit area).
 * `iconOnly` (a crowded strip) keeps the leading slot alone in a 40px tab, the name in the tooltip.
 */
export function Tab(props: {
  tab: TabId;
  info: TabInfo;
  selected: boolean;
  focusedGroup: boolean;
  width: number | null;
  iconOnly: boolean;
  /** Live displacement while a drag makes room (px), or the dragged tab's own offset. */
  shift: number;
  dragging: "self-attached" | "self-detached" | "other" | null;
  onPress(e: PointerEvent): void;
  onClose(): void;
  onMenu(x: number, y: number): void;
  onKeyDown(e: KeyboardEvent): void;
}) {
  const { tab, info, selected } = props;
  const canClose = closable(tab);
  const name = info.name ?? info.label;
  const style: CSSProperties = {};
  if (props.width !== null) style.width = props.width;
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
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      style={style}
      className={cn(
        "group/tab relative flex h-row shrink-0 items-center rounded-sm press-row",
        props.width === null && "w-max max-w-[200px] min-w-24",
        selected ? (props.focusedGroup ? "bg-active text-fg" : "bg-hover text-fg") : "text-fg-3 hover:bg-hover hover:text-fg-2",
        // Neighbours slide out of the way (150ms); open/close changes widths (120ms); the dragged tab follows the pointer.
        props.dragging === "other" && "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-(--ease-out-quint)",
        props.dragging === null && "motion-safe:transition-[width] motion-safe:duration-120",
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
        title={props.iconOnly ? name : info.title}
        aria-description={commentsDescription(info.comments)}
        onKeyDown={props.onKeyDown}
        className={cn("flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-sm focus-inset", props.iconOnly ? "justify-center" : "px-2")}
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {info.glyph ? <StateGlyph state={info.glyph} /> : <Glyph icon={info.icon} size={14} />}
        </span>
        <span className={cn("min-w-0 truncate", props.iconOnly && "sr-only")} aria-hidden={info.name && !props.iconOnly ? true : undefined}>
          {info.label}
          {info.detail && <span className="text-fg-3"> / {info.detail}</span>}
        </span>
        {info.name && !props.iconOnly && <span className="sr-only">{info.name}</span>}
        {info.comments > 0 && !props.iconOnly && <CommentCount count={info.comments} />}
        {info.status === "modified" && <span className="sr-only"> (unsaved)</span>}
        {info.status === "running" && <span className="sr-only"> (working)</span>}
        {info.glyph === "failed" && <span className="sr-only"> (failed)</span>}
        {info.glyph === "needs" && <span className="sr-only"> (needs you)</span>}
      </button>
      {!props.iconOnly && (
        <span className="relative mr-2 grid size-4 shrink-0 place-items-center">
          {info.status === "modified" && (
            <span
              aria-hidden
              data-testid="modified-dot"
              className={cn("size-1.5 rounded-full bg-fg-2", canClose && "group-focus-within/tab:invisible group-hover/tab:invisible")}
            />
          )}
          {canClose && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${name}`}
              title={`Close ${info.label}`}
              data-shortcut={`${MOD}W`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={props.onClose}
              className={cn(
                // A 24px hit area around the 16px slot (decision 36).
                "absolute -inset-1 grid place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg",
                selected && info.status !== "modified" ? "" : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100",
              )}
            >
              <Glyph icon={X} size={14} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
