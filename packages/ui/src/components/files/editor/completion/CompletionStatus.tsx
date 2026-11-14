import { Sparkle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "../../../../lib/cn";
import type { FileKey } from "../../../../lib/files";
import { Glyph } from "../../../primitives/Glyph";
import { completionStatus, statusText } from "./status";

/**
 * The file bar's inline-completion item (design decision 7): off / ready / thinking (a 1px shimmer under it, no
 * spinner) / paused, with the reason on hover and focus. Nothing until the editor has decided (Monaco still loading).
 * `compact` (a narrow bar) keeps the glyph only. 28px tall with a 16px glyph, like the bar's icon buttons.
 */
export function CompletionStatus({ fileKey, compact = false }: { fileKey: FileKey; compact?: boolean }) {
  const state = useSyncExternalStore(completionStatus.subscribe, () => completionStatus.get(fileKey));
  if (!state) return null;
  const { label, title } = statusText(state);
  const word = state.kind === "off" ? "Off" : state.kind === "paused" ? "Paused" : state.model;
  return (
    <span
      role="status"
      // Focusable so the reason (the tooltip) is reachable without a pointer.
      tabIndex={0}
      aria-label={`${label}. ${title}`}
      title={title}
      data-completion={state.kind}
      className={cn(
        // One of the bar's 28px items with a 16px glyph (polish step 4, E1); the glyph alone is a 28px square.
        "relative flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-sm select-none",
        compact ? "w-7" : "px-1.5",
        state.kind === "off" ? "text-fg-3" : state.kind === "paused" ? "text-warn" : "text-fg-2",
      )}
    >
      <Glyph icon={Sparkle} size={16} className={cn(state.kind === "thinking" && "text-fg")} />
      <span aria-hidden className={cn("max-w-30 truncate", compact && "hidden")}>
        {word}
      </span>
      {state.kind === "thinking" && <span aria-hidden className="octo-completion-shimmer" />}
    </span>
  );
}
