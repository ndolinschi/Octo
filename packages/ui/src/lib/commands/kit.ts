import type { ComponentType, ReactNode } from "react";

/**
 * What the Review tab needs from the commands feature. Features may not import each other, so `dock/TabView` loads the
 * commands chunk and hands it to the review as this kit (the way the files feature's Monaco loader is handed over).
 * `Provider` owns the run state of one review; `Bar` (header buttons) and `Panel` (output) read it.
 */
export type ReviewCommandsKit = {
  Provider: ComponentType<{ reviewId: string; worktreePresent: boolean; children: ReactNode }>;
  Bar: ComponentType;
  Panel: ComponentType;
};
