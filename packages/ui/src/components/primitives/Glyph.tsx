import type { LucideIcon, LucideProps } from "lucide-react";

/**
 * The one icon wrapper (contract v6 decision 14): lucide, drawn with `--icon-stroke` (1.5px rendered, at every size: the
 * `svg.lucide` rule in styles.css, so there is no per-use strokeWidth) in `currentColor`, square, at 16 (rows, buttons, tabs) or 14 (tree, chips, meta) —
 * nothing else, except 12 for the one disclosure chevron after a chip's label (E2, owner 2026-11-18).
 * Decorative by default (`aria-hidden`); pass `aria-label` when the glyph alone carries meaning.
 */
export function Glyph({ icon: Icon, size = 16, ...rest }: Omit<LucideProps, "size" | "ref"> & { icon: LucideIcon; size?: 12 | 14 | 16 }) {
  const labelled = rest["aria-label"] !== undefined;
  return <Icon size={size} aria-hidden={labelled ? undefined : true} {...rest} />;
}
