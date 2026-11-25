import { useRef } from "react";
import { GROUP_GAP } from "../../lib/constants";
import { ResizeHandle } from "../primitives/ResizeHandle";
import { resize, type Group, type Layout } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/** One drag: the layout and sizes it started from, how far the groups' minimums let it go, and the groups to show. */
type Drag = { layout: Layout; inner: number; floorA: number; floorB: number; moved: number; shown: readonly Group[] | null };

/**
 * The 8px gap between two groups, as a resize handle: drag, or arrows (±16px, Shift ±64);
 * double-click makes all groups equal. A drag shows the new widths through `preview` (the groups' own elements, once per
 * frame) and changes the layout once, when it lets go: a layout change renders the whole dock (every open conversation, the
 * composer, the file tree), and doing that on every pointer move dropped frames.
 */
export default function Divider({ index, value, preview }: { index: number; value: number; preview: (groups: readonly Group[]) => void }) {
  const ws = useWorkspace();
  const drag = useRef<Drag | null>(null);
  return (
    <ResizeHandle
      label="Resize panels"
      title="Drag to resize; double-click to make groups equal"
      value={value * 100}
      min={0}
      max={100}
      onDragStart={(handle) => {
        // What `ws.resize` computes, from the layout as the drag starts (it does not change until the drag lets go).
        const { layout } = ws;
        const a = layout.groups[index];
        const b = layout.groups[index + 1];
        const inner = (handle.parentElement?.clientWidth ?? 0) - (layout.groups.length - 1) * GROUP_GAP;
        drag.current =
          a && b && inner > 0 ? { layout, inner, floorA: ws.floorOf(a.id) / inner, floorB: ws.floorOf(b.id) / inner, moved: 0, shown: null } : null;
      }}
      onDrag={(dx) => {
        const d = drag.current;
        const a = d?.layout.groups[index];
        if (!d || !a) return;
        // As far as the groups' minimums let it go: past one, moving back moves the divider at once (as each move did when
        // it changed the layout itself).
        d.shown = resize(d.layout, index, (d.moved + dx) / d.inner, d.floorA, d.floorB).groups;
        d.moved = ((d.shown[index]?.size ?? a.size) - a.size) * d.inner;
      }}
      onFrame={() => {
        if (drag.current?.shown) preview(drag.current.shown);
      }}
      onDragEnd={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) ws.resize(index, d.moved);
      }}
      onKey={(dx) => ws.resize(index, dx)}
      onReset={() => ws.equalize()}
      className="group/divider relative w-gutter shrink-0 cursor-col-resize outline-none before:absolute before:-inset-x-1 before:inset-y-0 before:content-[''] focus-visible:shadow-none"
    >
      <span
        aria-hidden
        className="absolute top-bar bottom-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-[background-color] duration-fast group-hover/divider:bg-line-strong group-focus-visible/divider:bg-focus group-data-[dragging]/divider:bg-focus"
      />
    </ResizeHandle>
  );
}
