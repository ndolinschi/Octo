import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GROUP_GAP } from "../../lib/constants";
import { resize, type Group } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The 8px gap between two groups, as a resize handle: drag, or arrows (±16px, Shift ±64);
 * double-click makes all groups equal. A drag shows the new widths through `preview` (the groups' own elements, once per
 * frame) and changes the layout once, when it lets go: a layout change renders the whole dock (every open conversation, the
 * composer, the file tree), and doing that on every pointer move dropped frames.
 */
export default function Divider({ index, value, preview }: { index: number; value: number; preview: (groups: readonly Group[]) => void }) {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    // What `ws.resize` computes, from the layout as the drag starts (it does not change until the drag lets go).
    const { layout } = ws;
    const a = layout.groups[index];
    const b = layout.groups[index + 1];
    const inner = (handle.parentElement?.clientWidth ?? 0) - (layout.groups.length - 1) * GROUP_GAP;
    if (!a || !b || inner <= 0) return;
    const floorA = ws.floorOf(a.id) / inner;
    const floorB = ws.floorOf(b.id) / inner;
    let moved = 0;
    let frame = 0;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const body = document.body.style;
    body.cursor = "col-resize";
    body.userSelect = "none";
    let last = e.clientX;
    let shown: readonly Group[] | null = null;
    const show = () => {
      frame = 0;
      if (shown) preview(shown);
    };
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - last;
      if (!dx) return;
      last = ev.clientX;
      // As far as the groups' minimums let it go: past one, moving back moves the divider at once (as each move did when it
      // changed the layout itself).
      shown = resize(layout, index, (moved + dx) / inner, floorA, floorB).groups;
      moved = ((shown[index]?.size ?? a.size) - a.size) * inner;
      if (!frame) frame = requestAnimationFrame(show);
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
      if (moved) ws.resize(index, moved);
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
    ws.resize(index, e.key === "ArrowLeft" ? -step : step);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      title="Drag to resize; double-click to make groups equal"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => ws.equalize()}
      className="group/divider relative w-gutter shrink-0 cursor-col-resize outline-none before:absolute before:-inset-x-1 before:inset-y-0 before:content-[''] focus-visible:shadow-none"
    >
      <span
        aria-hidden
        className="absolute top-bar bottom-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-[background-color] duration-100 group-hover/divider:bg-line-strong group-focus-visible/divider:bg-focus group-data-[dragging]/divider:bg-focus"
      />
    </div>
  );
}
