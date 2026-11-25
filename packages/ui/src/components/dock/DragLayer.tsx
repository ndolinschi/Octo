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
          className="octo-fade fixed top-0 left-0 rounded-md border border-drop-edge bg-drop motion-safe:transition-[translate] motion-safe:duration-fast motion-safe:ease-out-quint"
          style={{ translate: `${ind.left}px ${ind.top}px`, width: ind.width, height: ind.height }}
        />
      )}
      {chip && (
        <div
          data-drag-chip
          className="octo-fade fixed top-0 left-0 flex h-ctl-sm max-w-60 items-center rounded-sm bg-overlay px-2 text-sm text-fg shadow-pop"
          style={{ translate: `${drag.x + 12}px ${drag.y + 12}px` }}
        >
          <span className="truncate">{drag.label}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
