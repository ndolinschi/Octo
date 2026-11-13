import type { ProjectMode } from "@octo/agent-client";

/** Parity B3: the mode of the next message. `isDefault`: it is the project's own default, not a choice for this message. */
export type ComposerMode = { value: ProjectMode; isDefault: boolean; choose(mode: ProjectMode): void; cycle(): void; makeDefault(): Promise<void> };
