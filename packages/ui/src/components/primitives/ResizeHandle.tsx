import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/**
 * A vertical resize handle (`role="separator"`): drag, or ←/→ (±16px, Shift ±64); double-click resets. The pointer and
 * keyboard logic of the dock's dividers and the sidebar's edge, written once. The caller owns the size and the look:
 * `onDragStart` gets the handle as a press begins (to read the sizes the drag starts from), `onDrag` each move's step and
 * the total since the press (keep it cheap: work it out, do not render), `onFrame` is called once per animation frame while
 * moves come in (show the new size there, on the elements, without a React render: a layout change per pointer move
 * re-rendered whole views and dropped frames), and `onDragEnd` (after a drag that moved) is the moment to commit. `onKey`
 * gets an arrow's step.
 */
export function ResizeHandle(props: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onDragStart?(handle: HTMLElement): void;
  onDrag(dx: number, total: number): void;
  onFrame?(): void;
  onDragEnd?(): void;
  onKey(dx: number): void;
  onReset(): void;
  className: string;
  /** The visible line; `data-dragging` on the handle marks a drag in progress. */
  children?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  // Ends a drag in progress without committing it (the handle unmounting mid-drag).
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = e.clientX;
    let last = e.clientX;
    let frame = 0;
    props.onDragStart?.(handle);
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const body = document.body.style;
    body.cursor = "col-resize";
    body.userSelect = "none";
    const show = () => {
      frame = 0;
      props.onFrame?.();
    };
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - last;
      if (!dx) return;
      last = ev.clientX;
      props.onDrag(dx, ev.clientX - start);
      if (props.onFrame && !frame) frame = requestAnimationFrame(show);
    };
    const end = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      body.cursor = "";
      body.userSelect = "";
      stop.current = null;
    };
    const up = () => {
      end();
      setDragging(false);
      // A press without a move (the first click of a double-click) is not a drag: nothing to commit.
      if (last !== start) props.onDragEnd?.();
    };
    stop.current = end;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    props.onKey(e.key === "ArrowLeft" ? -step : step);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={Math.round(props.value)}
      tabIndex={0}
      title={props.title}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={props.onReset}
      className={props.className}
    >
      {props.children}
    </div>
  );
}
