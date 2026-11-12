import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { TextArea, TextField } from "./TextField";

/** @deprecated The old name of `TextField` (`./TextField`). */
export const Input = TextField;

/** @deprecated The old name of `TextArea` (`./TextField`). */
export const Textarea = TextArea;

export function Field(props: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  /** Shown in the err colour; give it `errorId` and point the control's aria-describedby at it. */
  error?: string | null;
  errorId?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <label htmlFor={props.htmlFor} className="flex items-baseline gap-1.5 text-sm text-fg-2">
        {props.label}
        {props.optional && <span className="text-xs text-fg-3">optional</span>}
      </label>
      {props.children}
      {props.hint && <p className="text-xs text-fg-3">{props.hint}</p>}
      {props.error && (
        <p id={props.errorId} className="text-xs text-err">
          {props.error}
        </p>
      )}
    </div>
  );
}
