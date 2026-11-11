/* The streak's geometry per start screen (decision 21b), apart from the renderer so the main bundle can name a preset
   without loading `streak.ts`. */

/** Where the band's centre line passes, as fractions of the host's width and height. */
export type StreakAnchor = { x: number; y: number };

/**
 * A start screen's band geometry: where the centre line passes (`anchor`), how steep it runs (`rise`: the line climbs
 * `rise` × the host's height over its width — 1 is the host's diagonal) and how far below it the echo band sits (`echo`,
 * × the shorter side). Each screen routes the core where no text is.
 */
export type StreakPreset = { anchor: StreakAnchor; rise: number; echo: number };

/** Home: corner to corner through the upper middle; its text sits on translucent cards. */
export const STREAK_HOME: StreakPreset = { anchor: { x: 0.5, y: 0.34 }, rise: 1, echo: 0.46 };
/**
 * Empty project: from the top-left corner across the upper third to the right edge — the core passes ABOVE the
 * title / composer / facts block, which sits in the cool halo and the dark falloff; the echo runs below the block.
 */
export const STREAK_EMPTY: StreakPreset = { anchor: { x: 0.5, y: 0.14 }, rise: 0.3, echo: 0.66 };
/** No-projects hero: the diagonal through the middle; the short centred text keeps a local scrim. */
export const STREAK_HERO: StreakPreset = { anchor: { x: 0.5, y: 0.46 }, rise: 1, echo: 0.46 };
