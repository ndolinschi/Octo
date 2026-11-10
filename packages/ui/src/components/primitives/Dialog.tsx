import { X } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { IconButton } from "./Button";
import { usePresence } from "./Presence";
import { useModal } from "./useModal";

/**
 * Modal dialog. Put the primary action last in `footer`: side by side it sits on the right; below
 * 420px the buttons stack full width with the primary on top.
 */
export function Dialog(props: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md";
}) {
  const { onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const state = usePresence();

  useModal(panel, onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto p-3 sm:p-6" inert={state === "closed"}>
      <div className="octo-scrim fixed inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      {/* Optical placement above centre: a spacer, so every padding stays on the scale. */}
      <div aria-hidden className="h-[6vh] shrink-0 sm:h-[9vh]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        data-state={state}
        className={cn(
          "octo-overlay relative flex max-h-[88vh] w-full shrink-0 flex-col overscroll-contain rounded-lg border border-transparent bg-overlay shadow-pop",
          props.width === "sm" ? "max-w-[400px]" : "max-w-[520px]",
        )}
      >
        <header className="flex items-start gap-3 px-4 pt-4 pb-3 sm:px-5">
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id={titleId} className="text-heading text-fg">
              {props.title}
            </h2>
            {props.description && (
              <p id={descId} className="mt-1 text-sm text-fg-2">
                {props.description}
              </p>
            )}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mt-0.5 -mr-1.5" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 empty:hidden sm:px-5">{props.children}</div>
        {props.footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 px-4 pt-1 pb-4 max-[420px]:flex-col-reverse max-[420px]:flex-nowrap max-[420px]:items-stretch sm:px-5">
            {props.footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
