import { createRequiredContext } from "../../lib/context";

/**
 * A view asks its dock group to draw the start-screen streak behind the whole panel — tab strip and header included
 * (decision 21b: no hard cut under the header) — while it shows (`on`) and its tab is the group's active tab.
 */
export type Backdrop = { set(tab: string, on: boolean): void };

export const { Provider: BackdropProvider, useOptional: useBackdrop } = createRequiredContext<Backdrop>("useBackdrop");
