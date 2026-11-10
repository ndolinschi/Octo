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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 pt-[9vh]">
      <div className="animate-fade-in fixed inset-0 bg-scrim" onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        className={cn(
          "animate-pop-in relative flex max-h-[82vh] w-full flex-col rounded-lg border border-line-strong bg-overlay shadow-pop",
          props.width === "sm" ? "max-w-[420px]" : "max-w-[600px]",
        )}
      >
        <header className="flex items-start gap-3 px-5 pt-4 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">
              {props.title}
            </h2>
            {props.description && (
              <p id={descId} className="mt-0.5 text-sm text-fg-2">
                {props.description}
              </p>
            )}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mt-0.5 -mr-1.5" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{props.children}</div>
        {props.footer && (
          <footer className="flex items-center gap-2 border-t border-line px-5 py-3">{props.footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
