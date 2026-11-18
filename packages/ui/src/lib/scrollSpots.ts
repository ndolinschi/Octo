import { PREFS, jsonCodec, loadPref, writePref } from "./storage";

/**
 * Where a reader had scrolled a conversation, kept across a reload (the open tabs and the layout already are). One record per
 * project, keyed by the conversation's memory key; a conversation that was at the bottom has no entry (it opens at the end).
 */
export type ScrollSpot = { top: number; atBottom: boolean };

/** Entries kept per project, oldest dropped first: a project can have many sessions, a reader returns to a few. */
export const MAX_SPOTS = 40;

export type ScrollSpots = Record<string, ScrollSpot>;

const isSpot = (v: unknown): v is ScrollSpot =>
  typeof v === "object" &&
  v !== null &&
  "top" in v &&
  typeof v.top === "number" &&
  Number.isFinite(v.top) &&
  "atBottom" in v &&
  typeof v.atBottom === "boolean";

/** Keeps the entries that are valid spots; anything else stored (or nothing) reads as empty. */
export function parseSpots(parsed: unknown): ScrollSpots {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: ScrollSpots = {};
  for (const [k, v] of Object.entries(parsed)) if (isSpot(v)) out[k] = { top: Math.max(0, v.top), atBottom: v.atBottom };
  return out;
}

/** `spots` with `key` set to `spot` (newest last), or removed when the reader was at the bottom; at most `MAX_SPOTS` entries. */
export function withSpot(spots: ScrollSpots, key: string, spot: ScrollSpot): ScrollSpots {
  const { [key]: _old, ...rest } = spots;
  if (spot.atBottom) return rest;
  const entries = Object.entries({ ...rest, [key]: { top: Math.max(0, Math.round(spot.top)), atBottom: false } });
  return Object.fromEntries(entries.slice(-MAX_SPOTS));
}

const codec = jsonCodec(parseSpots);

/** The saved position of one conversation, or `undefined` (never scrolled up, or nothing stored). */
export function loadSpot(projectId: string, key: string): ScrollSpot | undefined {
  return loadPref(PREFS.scrollSpots(projectId), codec)[key];
}

/** Saves (or, at the bottom, clears) one conversation's position. */
export function saveSpot(projectId: string, key: string, spot: ScrollSpot): void {
  const at = PREFS.scrollSpots(projectId);
  writePref(at, codec.stringify(withSpot(loadPref(at, codec), key, spot)));
}
