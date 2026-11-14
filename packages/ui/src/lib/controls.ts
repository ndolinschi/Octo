/**
 * The one size scale for controls (decision 90c), used by every control primitive (Button, IconButton, TextField,
 * Select, SearchField, ListRow, Checkbox...). A feature never writes a control height; it passes `size`.
 *
 *   xs 24   compact toolbar buttons, chips, meta rows        sm 28   tabs, tree and menu rows, quiet buttons
 *   md 32   the default: fields, buttons, nav rows           lg 40   header rows, touch height, one-line composer
 *
 * Token names in `styles.css` (block "component library tokens"): `--spacing-ctl-xs|sm|md|lg` give `h-ctl-*`, `size-ctl-*`,
 * `min-h-ctl-*`. The older spellings are the same pixels and stay defined, so no existing class breaks:
 *   24 = `h-6` = `h-chip` = `h-ctl-xs`      28 = `h-7` = `h-row` = `h-ctl-sm`
 *   32 = `h-8` = `h-row-nav` = `h-ctl-md`   40 = `h-10` = `h-bar` = `h-ctl-lg`
 * New code writes only the `ctl` names, and only inside a primitive.
 *
 * Touch (decision 90c): under a coarse pointer or a narrow window (`touch:` variant) the hit area grows to 40px inside the
 * primitive: buttons, icon buttons, checkboxes and switches keep their look and gain an invisible 40px target (`touch-hit`);
 * fields and list rows really become 40px tall because their text is 16px there.
 */
export const CONTROL_SIZES = ["xs", "sm", "md", "lg"] as const;
export type ControlSize = (typeof CONTROL_SIZES)[number];

/** The pixel height of each size. `styles.css` declares the same four numbers; a test keeps them equal. */
export const CONTROL_PX: Record<ControlSize, number> = { xs: 24, sm: 28, md: 32, lg: 40 };

export type ControlSpec = {
  /** `h-ctl-*`. */
  h: string;
  /** `size-ctl-*` (icon buttons, checkboxes). */
  square: string;
  /** `min-h-ctl-*` (rows that may grow to two lines). */
  minH: string;
  /** Text size of the control's label. */
  text: string;
  /** Radius rule: 6px for xs-md, 8px for lg; `rounded-full` is only ever chosen by a `round` variant. */
  radius: string;
  /** Glyph beside a label. */
  glyph: 14 | 16;
  /** Glyph of an icon-only button. */
  iconGlyph: 14 | 16;
  /** Box of the working ring (`Spinner`): one per control size. */
  spinner: 12 | 14 | 16;
};

export const CONTROL: Record<ControlSize, ControlSpec> = {
  xs: { h: "h-ctl-xs", square: "size-ctl-xs", minH: "min-h-ctl-xs", text: "text-xs", radius: "rounded-sm", glyph: 14, iconGlyph: 14, spinner: 12 },
  sm: { h: "h-ctl-sm", square: "size-ctl-sm", minH: "min-h-ctl-sm", text: "text-sm", radius: "rounded-sm", glyph: 14, iconGlyph: 16, spinner: 12 },
  md: { h: "h-ctl-md", square: "size-ctl-md", minH: "min-h-ctl-md", text: "text-sm", radius: "rounded-sm", glyph: 14, iconGlyph: 16, spinner: 14 },
  lg: { h: "h-ctl-lg", square: "size-ctl-lg", minH: "min-h-ctl-lg", text: "text-sm", radius: "rounded-md", glyph: 16, iconGlyph: 16, spinner: 16 },
};

/**
 * The one look of a text field (decision 90c, the majority treatment of the code base): 8px radius, `field-edge` (a hairline
 * no brighter than a card's edge: polish trial T3), `panel` surface (recessed inside a raised card), 13px text (16px on touch so
 * iOS does not zoom), the placeholder in plain `fg-3` (was `fg-3/60` italic, 3.3:1), and ONE focus indicator for every field primitive:
 * the border becomes `fg` and the global shadow ring is switched off. Validation error: `aria-invalid` colours the border.
 */
export const FIELD =
  "rounded-md border border-field-edge bg-panel text-sm text-fg placeholder:text-fg-3 transition-[border-color] duration-100 focus:border-fg focus:outline-none focus-visible:shadow-none aria-invalid:border-err disabled:opacity-50 touch:text-input-touch";

/** The same focus rule for a frame that holds an input (`SearchField`): the frame reacts to `focus-within`. */
export const FIELD_FRAME =
  "rounded-md border border-field-edge bg-panel text-sm text-fg transition-[border-color] duration-100 focus-within:border-fg touch:text-input-touch";

/** Padding of a button by look: boxed buttons (filled, bordered, danger) are a step wider than quiet text buttons. */
export const BUTTON_PAD: Record<"boxed" | "quiet", Record<ControlSize, string>> = {
  boxed: { xs: "px-2", sm: "px-3", md: "px-3", lg: "px-4" },
  quiet: { xs: "px-2", sm: "px-2", md: "px-3", lg: "px-3" },
};

/** Legacy `IconButton` sizes (`sm` was 24px, `md` 28px) as the sizes of the one scale. */
export function legacyIconSize(size: "sm" | "md"): ControlSize {
  return size === "sm" ? "xs" : "sm";
}

/** The box of the working ring for a `Spinner`: a control size, or a pixel number kept for old call sites. */
export function spinnerBox(size: ControlSize | number): number {
  return typeof size === "number" ? size : CONTROL[size].spinner;
}
