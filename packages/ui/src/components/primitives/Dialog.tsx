import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useHistoryLayer } from "../../lib/historyLayer";
import { useScrollFade } from "../../lib/hooks";
import { usePhone } from "../../lib/phone";
import { IconButton } from "./IconButton";
import { usePresence } from "./Presence";
import { useModal } from "./useModal";

/**
 * Modal dialog. Put the primary action last in `footer`: side by side it sits on the right; below
 * 420px the buttons stack full width with the primary on top.
 *
 * Decision 51 — it always fits the window: never taller or wider than the window minus 24px; the title and the actions
 * stay put and only the body scrolls, with a hairline under the title / above the actions while there is more to
 * scroll; below 560px of height or 600px of width it is a full-window sheet. The panel is a size container (`dialog`),
 * so field grids inside switch to one column below 520px of dialog width (`@min-[520px]/dialog:grid-cols-2`).
 */
export function Dialog(props: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** `xl`: 720px, a two-column reference whose rows must stay on one line (the shortcut list). */
  width?: "sm" | "md" | "lg" | "xl";
  /** A row under the title (view tabs). */
  nav?: ReactNode;
  /**
   * A long read-only body (the shortcut list): its scrolling ends fade, and PageUp / PageDown / Home / End / the arrows scroll
   * it while focus is on the dialog's buttons (it has no field of its own to take them).
   */
  reading?: boolean;
}) {
  const { onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const state = usePresence();

  useModal(panel, onClose);
  // Direction 7: on the phone a dialog is a history entry (the system's Back closes it, as it does a sheet).
  useHistoryLayer(usePhone() && state === "open", () => onClose());
  const body = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(body);
  // The ends fade only for a `reading` body (`fade-y` reads the attribute this sets).
  useScrollFade(body, "y");
  const reading = props.reading === true;
  useEffect(() => {
    const el = panel.current;
    if (!reading || !el) return;
    const onKey = (e: KeyboardEvent) => {
      const b = body.current;
      if (!b || e.altKey || e.ctrlKey || e.metaKey) return;
      const page = Math.max(40, b.clientHeight - 40);
      const by: Record<string, number> = { PageDown: page, PageUp: -page, ArrowDown: 40, ArrowUp: -40, End: b.scrollHeight, Home: -b.scrollHeight };
      const d = by[e.key];
      if (d === undefined) return;
      e.preventDefault();
      b.scrollBy({ top: d });
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [reading]);

  return createPortal(
    <div className={cn("fixed inset-0 z-50 flex flex-col items-center justify-center p-3", SHEET_OUTER)} inert={state === "closed"}>
      <div className="octo-scrim fixed inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        data-state={state}
        className={cn(
          "octo-overlay @container/dialog relative flex max-h-[calc(100dvh-24px)] min-h-0 w-full max-w-[calc(100vw-24px)] shrink flex-col overscroll-contain rounded-xl border border-transparent bg-overlay shadow-pop",
          props.width === "sm"
            ? "sm:max-w-[400px]"
            : props.width === "lg"
              ? "sm:max-w-dialog-wide"
              : props.width === "xl"
                ? "sm:max-w-[720px]"
                : "sm:max-w-[520px]",
          SHEET_PANEL,
        )}
      >
        <div className={cn("flex shrink-0 items-start gap-3 px-4 pt-4 pb-3 sm:px-5", edges.top && "shadow-[inset_0_-1px_0_var(--octo-line)]")}>
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
        </div>
        {props.nav && <div className="px-4 pb-3 sm:px-5">{props.nav}</div>}
        <div
          ref={body}
          data-dialog-body
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 empty:hidden sm:px-5",
            reading ? "fade-y pb-6" : props.footer ? "pb-3" : "pb-4",
          )}
        >
          {props.children}
        </div>
        {props.footer && (
          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-4 max-[420px]:flex-col-reverse max-[420px]:flex-nowrap max-[420px]:items-stretch sm:px-5",
              edges.bottom && "shadow-[inset_0_1px_0_var(--octo-line)]",
            )}
          >
            {props.footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Below 560px of window height or 600px of width the dialog is a full-window sheet (decision 51). */
const SHEET_OUTER = "[@media(max-height:559px)]:p-0 max-[599px]:p-0";
const SHEET_PANEL =
  "[@media(max-height:559px)]:h-dvh [@media(max-height:559px)]:max-h-dvh [@media(max-height:559px)]:max-w-none [@media(max-height:559px)]:rounded-none max-[599px]:h-dvh max-[599px]:max-h-dvh max-[599px]:max-w-none max-[599px]:rounded-none";

/** Whether the body has more to scroll above / below (the hairlines under the title and above the actions). */
function useScrollEdges(ref: RefObject<HTMLDivElement | null>): { top: boolean; bottom: boolean } {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 0;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref]);
  return edges;
}
