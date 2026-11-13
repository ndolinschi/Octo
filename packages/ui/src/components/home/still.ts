/**
 * Decision 76: a glyph that is not working right now stays still. The ring's arc and dot are animated by the shared
 * state glyph, so a count tile or an idle row switches its animations off with this class on its wrapper.
 */
export const STILL = "[&_.octo-ring-turn]:!animate-none";
