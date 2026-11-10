import type { LucideIcon, LucideProps } from "lucide-react";

/**
 * The one icon wrapper (contract v6 decision 14): lucide, 1.5px stroke at every size (absolute), drawn
 * in `currentColor`, square, at 16 (rows, buttons, tabs) or 14 (tree, chips, meta) — nothing else.
 * Decorative by default (`aria-hidden`); pass `aria-label` when the glyph alone carries meaning.
 */
export function Glyph({ icon: Icon, size = 16, ...rest }: Omit<LucideProps, "size" | "ref"> & { icon: LucideIcon; size?: 14 | 16 }) {
  const labelled = rest["aria-label"] !== undefined;
  return <Icon size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden={labelled ? undefined : true} {...rest} />;
}
