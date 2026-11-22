import { readyLazy } from "../../lib/readyLazy";

/**
 * Decision 101: the run card's body is its own chunk (out of the entry and out of the delegation rows' chunk), fetched as soon as
 * a surface that can open a card loads, so the first card renders without a frame of nothing.
 */
export const runCardBody = readyLazy(() => import("./AgentRunCard").then((m) => m.RunCardBody));

/** The card's frame: the neutral raised surface of the conversation's cards, on the column's edge (no coloured edge, decision 81). */
export const RUN_CARD_FRAME = "-mx-3 my-1 rounded-md bg-raised px-3 pb-2 octo-in-card";
