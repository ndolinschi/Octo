/* The streak's geometry per start screen (decisions 21b, 32), apart from the renderer so the main bundle can name a preset
   without loading `streak.ts`. */

/** Where the band's centre line passes, as fractions of the host's width and height. */
export type StreakAnchor = { x: number; y: number };

/**
 * A start screen's band geometry: where the centre line passes (`anchor`), how steep it runs (`rise`: the line climbs
 * `rise` × the host's height over its width — 1 is the host's diagonal) and how far below it the echo band sits (`echo`,
 * × the shorter side). Each screen routes the core where no text is.
 */
export type StreakPreset = { anchor: StreakAnchor; rise: number; echo: number; narrow?: { anchor: StreakAnchor; rise: number } };

/** Below this host width a preset's `narrow` geometry applies (a portrait host makes the same rise much steeper). */
export const STREAK_NARROW_BELOW = 640;

/**
 * Home: a shallow band across the lower part — behind the translucent cards and through the free space under them —
 * so the title row stays in the dark (decision 32: the band is moved, never patched with a scrim).
 */
export const STREAK_HOME: StreakPreset = { anchor: { x: 0.5, y: 0.72 }, rise: 0.45, echo: 0.46 };
/**
 * Empty project: from the top-left corner across the upper third to the right edge — the core passes ABOVE the
 * title / composer / facts block, which sits in the cool halo and the dark falloff; the echo runs below the block.
 */
export const STREAK_EMPTY: StreakPreset = { anchor: { x: 0.5, y: 0.14 }, rise: 0.3, echo: 0.66, narrow: { anchor: { x: 0.5, y: 0.1 }, rise: 0.12 } };
/**
 * No-projects hero: a shallow band across the upper quarter, so the centred text sits in the dark under its warm edge
 * (decision 32: the band is moved, never patched with a scrim).
 */
export const STREAK_HERO: StreakPreset = { anchor: { x: 0.5, y: 0.2 }, rise: 0.55, echo: 0.46, narrow: { anchor: { x: 0.5, y: 0.16 }, rise: 0.2 } };
