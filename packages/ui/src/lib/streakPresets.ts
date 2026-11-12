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
 * Decision 91a: ONE band for every screen that shows the streak — one placement (a band at the top of the panel, `--octo-band-h`
 * tall, over an area with no content: Home's heading area, the empty conversation's upper third, the connect and no-projects
 * screens) and one angle: the core climbs gently from the lower left to the upper right inside it.
 */
export const STREAK_BAND: StreakPreset = { anchor: { x: 0.5, y: 0.5 }, rise: 0.5, echo: 0.5, narrow: { anchor: { x: 0.5, y: 0.5 }, rise: 0.25 } };

/** @deprecated Decision 91a: every screen uses `STREAK_BAND`; these names stay so the callers of the earlier presets keep compiling. */
export const STREAK_HOME = STREAK_BAND;
/** @deprecated See `STREAK_HOME`. */
export const STREAK_EMPTY = STREAK_BAND;
/** @deprecated See `STREAK_HOME`. */
export const STREAK_HERO = STREAK_BAND;
