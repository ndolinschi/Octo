import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const CONTROL =
  "w-full rounded-md border border-input-border bg-panel px-3 text-sm text-fg placeholder:text-fg-3 transition-[border-color] duration-100 focus:border-fg focus:outline-none focus-visible:shadow-none aria-invalid:border-err";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL, "h-8", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(CONTROL, "resize-y py-1.5 leading-5", className)} {...rest} />;
});

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
