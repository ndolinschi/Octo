import { Sparkle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "../../../../lib/cn";
import type { FileKey } from "../../../../lib/files";
import { Glyph } from "../../../primitives/Glyph";
import { completionStatus, statusText } from "./status";

/**
 * The file bar's inline-completion item (design decision 7): off / ready / thinking (a 1px shimmer under it, no
 * spinner) / paused, with the reason on hover and focus. Nothing until the editor has decided (Monaco still loading).
 * `compact` (a narrow bar) keeps the glyph only.
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
        "relative flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 select-none",
        state.kind === "off" ? "text-fg-3" : state.kind === "paused" ? "text-warn" : "text-fg-2",
      )}
    >
      <Glyph icon={Sparkle} size={14} className={cn(state.kind === "thinking" && "text-fg")} />
      <span aria-hidden className={cn("max-w-30 truncate", compact && "hidden")}>
        {word}
      </span>
      {state.kind === "thinking" && <span aria-hidden className="octo-completion-shimmer" />}
    </span>
  );
}
