import type { LucideIcon } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ControlSize } from "../../lib/controls";
import { IconButton } from "./IconButton";

export type FileInputHandle = { open(): void };

/**
 * The platform's file dialog (decision 90: native inputs live in primitives): a hidden `<input type="file">` that gives the
 * chosen files to `onFiles` and resets itself so the same file can be chosen twice.
 *
 * - Without `button`: opened from your own button through the handle, `ref.current.open()` (the composer's attach menu).
 * - With `button` (`icon`, optional `size`, `disabled`): renders the icon button too (a note import); `label` is its accessible
 *   name and tooltip.
 *
 * Not for: dropping files on a surface, a visible file name (a `Field` with its own display). Hosts with their own dialog
 * (`HostCapabilities`) do not need it.
 */
export const FileInput = forwardRef<
  FileInputHandle,
  {
    accept?: string;
    multiple?: boolean;
    label: string;
    onFiles(files: File[]): void;
    button?: { icon: LucideIcon; size?: ControlSize; disabled?: boolean };
  }
>(function FileInput(props, handle) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({ open: () => input.current?.click() }), []);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={props.label}
        {...(props.accept ? { accept: props.accept } : {})}
        multiple={props.multiple === true}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) props.onFiles(files);
        }}
      />
      {props.button && (
        <IconButton
          icon={props.button.icon}
          label={props.label}
          size={props.button.size ?? "sm"}
          disabled={props.button.disabled ?? false}
          onClick={() => input.current?.click()}
        />
      )}
    </>
  );
});
