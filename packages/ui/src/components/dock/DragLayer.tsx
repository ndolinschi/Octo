import { createPortal } from "react-dom";
import { useDrag } from "./drag";

/**
 * Drag feedback over everything: once a tab is pulled off its strip, a chip with its name beside the pointer; over a
 * group body, the split / move zone (it glides between targets; under reduced motion it only fades). Inside a strip
 * there is no bar — the neighbours make room (decision 25).
 */
export function DragLayer() {
  const drag = useDrag();
  if (!drag) return null;
  const ind = drag.indicator;
  // Inside its own strip the tab itself follows the pointer; the chip shows only once it has detached.
  const chip = !drag.attached;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      {ind && (
        <div
          data-drop-zone
          className="octo-fade fixed rounded-md border border-drop-edge bg-drop motion-safe:transition-[left,top,width,height] motion-safe:duration-[120ms] motion-safe:ease-(--ease-out-quint)"
          style={{ left: ind.left, top: ind.top, width: ind.width, height: ind.height }}
        />
      )}
      {chip && (
        <div
          data-drag-chip
          className="octo-fade fixed flex h-7 max-w-[240px] items-center rounded-sm border border-line-strong bg-overlay px-2.5 text-sm text-fg shadow-pop"
          style={{ left: drag.x + 12, top: drag.y + 10 }}
        >
          <span className="truncate">{drag.label}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
