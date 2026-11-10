import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { IconButton } from "./Button";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

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

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.offsetParent !== null,
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-3 pt-[6vh] sm:p-6 sm:pt-[9vh]">
      <div className="fixed inset-0 bg-scrim" onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        className={cn(
          "relative flex max-h-[88vh] w-full flex-col overscroll-contain rounded-lg border border-transparent bg-overlay shadow-pop",
          props.width === "sm" ? "max-w-[400px]" : "max-w-[520px]",
        )}
      >
        <header className="flex items-center gap-3 px-4 pt-4 pb-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[14px] leading-5 font-semibold">
              {props.title}
            </h2>
            {props.description && (
              <p id={descId} className="mt-0.5 text-sm text-fg-3">
                {props.description}
              </p>
            )}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-1.5" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-5">{props.children}</div>
        {props.footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 px-4 pt-1 pb-4 sm:px-5">{props.footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
