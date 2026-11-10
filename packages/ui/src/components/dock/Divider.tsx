import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The 8px gap between two groups, as a resize handle: drag, or arrows (±16px, Shift ±64);
 * double-click makes all groups equal.
 */
export function Divider({ index, value }: { index: number; value: number }) {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    let last = e.clientX;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const body = document.body.style;
    body.cursor = "col-resize";
    body.userSelect = "none";
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - last;
      if (!dx) return;
      last = ev.clientX;
      ws.resize(index, dx);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      body.cursor = "";
      body.userSelect = "";
      setDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    ws.resize(index, e.key === "ArrowLeft" ? -step : step);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize groups"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      title="Drag to resize; double-click to make groups equal"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => ws.equalize()}
      className="group/divider relative w-gutter shrink-0 cursor-col-resize outline-none focus-visible:shadow-none before:absolute before:inset-y-0 before:-inset-x-1 before:content-['']"
    >
      <span
        aria-hidden
        className="absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-[background-color] duration-100 group-hover/divider:bg-line-strong group-focus-visible/divider:bg-focus group-data-[dragging]/divider:bg-focus"
      />
    </div>
  );
}
