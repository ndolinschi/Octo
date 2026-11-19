import { ResizeHandle } from "../primitives/ResizeHandle";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The 8px gap between two groups, as a resize handle: drag, or arrows (±16px, Shift ±64);
 * double-click makes all groups equal.
 */
export default function Divider({ index, value }: { index: number; value: number }) {
  const ws = useWorkspace();
  return (
    <ResizeHandle
      label="Resize panels"
      title="Drag to resize; double-click to make groups equal"
      value={value * 100}
      min={0}
      max={100}
      onDrag={(dx) => ws.resize(index, dx)}
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
