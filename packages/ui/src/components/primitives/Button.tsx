import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { BUTTON_PAD, CONTROL, legacyIconSize, type ControlSize } from "../../lib/controls";
import { Glyph } from "./Glyph";
import { IconButton as ScaleIconButton, type IconButtonProps as ScaleIconButtonProps } from "./IconButton";
import { Spinner } from "./Status";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "link" | "danger" | "ghost" | "float";

const VARIANT: Record<ButtonVariant, string> = {
  // 6d: forced colours drop the fill, so the filled button gets the system's button border there (it read as plain text).
  primary: "bg-primary text-primary-fg font-medium hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100 forced-colors:border",
  secondary: "border border-line-strong text-fg hover:bg-hover disabled:text-fg-3",
  quiet: "text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-3",
  // An opaque surface for a control that floats over content (the composer's status chips): it must not show text through it.
  float: "bg-overlay text-fg shadow-float octo-ring-float hover:bg-raised disabled:text-fg-3 forced-colors:border forced-colors:border-[CanvasText]",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-3",
  // Decision 81c: destructive and deny actions are quiet buttons with coloured text, not coloured outlines.
  danger: "text-err hover:bg-hover disabled:text-fg-3",
  // The colour of a link comes from its `tone` (below), so `tone="quiet"` wins without `!`.
  link: "rounded-xs underline-offset-2 hover:underline focus-visible:underline disabled:text-fg-3",
};

/** `ghost` keeps the padding it always had (a boxed step), so existing call sites do not change width. */
const PAD_KIND: Record<ButtonVariant, "boxed" | "quiet" | null> = {
  primary: "boxed",
  secondary: "boxed",
  float: "boxed",
  danger: "boxed",
  ghost: "boxed",
  quiet: "quiet",
  link: null,
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `ghost` is the old name of `quiet`, kept so no call site breaks: write `quiet`. */
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Leading glyph (14px; 16 at `lg`). */
  icon?: LucideIcon;
  /** Trailing glyph (a chevron, an external-link mark). */
  iconEnd?: LucideIcon;
  /** A toggle: `aria-pressed`, the `active` fill. */
  pressed?: boolean;
  /** Work in progress: the working ring replaces the leading glyph, clicks are ignored, the width does not change. */
  loading?: boolean;
  fullWidth?: boolean;
  /** `link` only: a path or id in the mono face. */
  mono?: boolean;
  /** `link` only: `quiet` is `fg-2` text that underlines on hover (paths, secondary links). */
  tone?: "link" | "quiet";
};

const SHRINK_CLASS = /(^|\s)(shrink|min-w-0|flex-1)(\s|$)/;

/**
 * The labelled action (decision 90).
 *
 * - `variant`: `primary` (the one filled button of a surface, decision 64b), `secondary` (bordered), `quiet` (text button,
 *   the default for toolbars), `danger` (quiet with error-coloured text), `float` (bordered with an opaque surface, for chips over content), `link` (inline text link, no box).
 * - `size`: xs 24 (`text-xs`), sm 28, md 32 (default), lg 40.
 * - `icon`, `iconEnd`, `pressed`, `loading`, `fullWidth`.
 * - Touch: a 40px hit area grows around it without changing its look.
 *
 * Not for: icon-only controls (`IconButton`), a value that opens a list (`Chip`, `Select`), a row in a list (`ListRow`),
 * one choice among a few (`Segmented`), navigation that changes URL (a real link).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon: Icon,
    iconEnd: IconEnd,
    pressed,
    loading = false,
    fullWidth = false,
    mono = false,
    tone = "link",
    className,
    children,
    type = "button",
    onClick,
    ...rest
  },
  ref,
) {
  const spec = CONTROL[size];
  const pad = PAD_KIND[variant];
  const link = variant === "link";
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? undefined : onClick}
      className={cn(
        "touch-hit inline-flex items-center whitespace-nowrap disabled:pointer-events-none",
        !(className && SHRINK_CLASS.test(className)) && "shrink-0",
        link ? "gap-1" : cn("press justify-center gap-1.5", spec.h, spec.radius),
        pad && BUTTON_PAD[pad][size],
        spec.text,
        VARIANT[variant],
        link && (tone === "quiet" ? "text-fg-2 hover:text-fg" : "text-link"),
        link && mono && "font-mono",
        pressed && !link && "bg-active text-fg",
        loading && "pointer-events-none",
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size} className="text-current" /> : Icon && <Glyph icon={Icon} size={spec.glyph} />}
      {children}
      {IconEnd && <Glyph icon={IconEnd} size={spec.glyph} />}
    </button>
  );
});

/** The old icon button sizes: `sm` was 24px and `md` (default) 28px. */
export type IconButtonProps = Omit<ScaleIconButtonProps, "size"> & { size?: "sm" | "md" };

/**
 * @deprecated Import `IconButton` from `./IconButton`: sizes xs 24 / sm 28 / md 32 / lg 40. This wrapper keeps the old
 * meaning of `size` (sm 24, md 28) so existing call sites render the same pixels; migrate `size="sm"` to `xs` and an
 * omitted size to `sm`.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ size = "md", ...rest }, ref) {
  return <ScaleIconButton ref={ref} size={legacyIconSize(size)} {...rest} />;
});
