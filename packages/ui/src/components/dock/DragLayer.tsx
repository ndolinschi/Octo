import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useDrag } from "./drag";

/**
 * Drag feedback, drawn over everything so the dock's layout never changes while dragging: a chip
 * with the tab's name beside the pointer, and the drop indicator (insertion bar or zone). The
 * indicator glides between targets; under reduced motion it only fades.
 */
export function DragLayer() {
  const drag = useDrag();
  if (!drag) return null;
  const ind = drag.indicator;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      {ind && (
        <div
          key={ind.shape}
          className={cn(
            "octo-fade fixed motion-safe:transition-[left,top,width,height] motion-safe:duration-[120ms] motion-safe:ease-(--ease-out-quint)",
            ind.shape === "bar" ? "rounded-full bg-accent" : "rounded-md border border-drop-edge bg-drop",
          )}
          style={{ left: ind.left, top: ind.top, width: ind.width, height: ind.height }}
        />
      )}
      <div
        className="octo-fade fixed flex h-7 max-w-[240px] items-center rounded-sm border border-line-strong bg-overlay px-2.5 text-sm text-fg shadow-pop"
        style={{ left: drag.x + 12, top: drag.y + 10 }}
      >
        <span className="truncate">{drag.label}</span>
      </div>
    </div>,
    document.body,
  );
}
