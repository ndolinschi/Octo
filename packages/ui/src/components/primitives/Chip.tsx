import { ChevronsUpDown, type LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "./Glyph";

/**
 * A label cut in the middle only when its row is too narrow (CSS, no character budget): the head gives way with an
 * ellipsis while the last few characters stay ("product-configura…nager"). A short label is one plain span. The tooltip has it whole.
 */
function MiddleLabel({ text }: { text: string }) {
  if (text.length <= 14) return <span className="min-w-0 truncate">{text}</span>;
  const tail = Math.min(8, Math.floor(text.length / 3));
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="min-w-0 truncate">{text.slice(0, text.length - tail)}</span>
      <span className="shrink-0">{text.slice(text.length - tail)}</span>
    </span>
  );
}

/**
 * A ghost chip (decision 62: the composer's control row, and the same model chip in the title bar): 28px, glyph + label + the up-down chevron pair (it opens
 * upward, decision 56). `bare` drops the label (the row is too narrow); the accessible name keeps it.
 */
export const Chip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: LucideIcon;
    label: string;
    name: string;
    tip?: string | undefined;
    bare?: boolean;
    open?: boolean;
    warn?: boolean;
  }
>(function Chip({ icon, label, name, tip, bare = false, open = false, warn = false, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-composer-chip
      aria-label={`${name}: ${label}`}
      title={tip ?? `${name}: ${label}`}
      aria-expanded={open}
      className={cn(
        "flex h-7 min-w-0 shrink-0 press items-center gap-1.5 rounded-sm text-sm hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50",
        bare ? "w-7 justify-center" : "px-2",
        open ? "bg-active text-fg" : warn ? "text-warn" : "text-fg-2",
        className,
      )}
      {...rest}
    >
      <Glyph icon={icon} size={14} className="shrink-0" />
      {!bare && (
        <span data-chip-label className="flex min-w-0 items-center gap-1.5">
          <MiddleLabel text={label} />
          <Glyph icon={ChevronsUpDown} size={14} className="shrink-0 text-fg-3" />
        </span>
      )}
    </button>
  );
});
