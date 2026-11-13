/** B12: at most eight images go with one message (the decisions about each picture are in `imagePlan.ts`, loaded with the first one). */
export const IMAGE_MAX_COUNT = 8;

/** How many of `incoming` fit beside `have` already attached (the rest are said, not silently dropped). */
export function room(have: number, incoming: number): { take: number; over: number } {
  const take = Math.max(0, Math.min(incoming, IMAGE_MAX_COUNT - have));
  return { take, over: incoming - take };
}
