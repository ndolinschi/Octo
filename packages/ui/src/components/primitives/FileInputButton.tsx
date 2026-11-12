import type { LucideIcon } from "lucide-react";
import { useRef } from "react";
import type { ControlSize } from "../../lib/controls";
import { IconButton } from "./IconButton";

/**
 * An icon button that opens the system file chooser and hands the one chosen file to `onFile` (a note import). The
 * platform `<input type="file">` stays hidden inside; `label` is the accessible name and the tooltip.
 *
 * Not for: dropping files on a surface, several files, a visible file name (a `Field` with its own display).
 */
export function FileInputButton(props: { icon: LucideIcon; label: string; accept: string; onFile(file: File): void; size?: ControlSize; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={props.accept}
        hidden
        aria-label={props.label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) props.onFile(file);
        }}
      />
      <IconButton icon={props.icon} label={props.label} size={props.size ?? "sm"} disabled={props.disabled ?? false} onClick={() => input.current?.click()} />
    </>
  );
}
