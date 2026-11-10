import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg font-medium hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100",
  secondary: "border border-line-strong text-fg hover:bg-hover disabled:text-fg-3",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-3",
  danger: "border border-line-strong text-err hover:bg-hover",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-sm",
  md: "h-8 px-3 text-sm gap-1.5 rounded-sm",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,color,opacity] duration-100 disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />}
      {children}
    </button>
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  size?: "sm" | "md";
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, pressed, size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm text-fg-3 transition-[background-color,color] duration-100 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-6" : "size-7",
        pressed && "bg-active text-fg",
        className,
      )}
      {...rest}
    >
      <Icon size={size === "sm" ? 14 : 16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
    </button>
  );
});
