import type { ProjectMode } from "@octo/agent-client";

/** Parity B3: the order Shift+Tab cycles through. (Labels and tooltips are in `modeLabels.ts`, with the chip's chunk.) */
export const MODES: readonly ProjectMode[] = ["agent", "ask", "plan"];

/** One short line while a read-only mode is on; null for Agent. */
export function modeNote(mode: ProjectMode): string | null {
  if (mode === "ask") return "Ask mode is read-only: no files or commands are changed.";
  if (mode === "plan") return "Plan mode is read-only: messages refine the plan for you to approve before anything runs.";
  return null;
}

/** The next mode in the cycle (Shift+Tab). */
export function nextMode(mode: ProjectMode): ProjectMode {
  const i = MODES.indexOf(mode);
  return MODES[(i + 1) % MODES.length] ?? "agent";
}

/** The mode a message is sent with: this message's choice, else the project's default, else Agent. */
export function effectiveMode(override: ProjectMode | null, projectDefault: ProjectMode | undefined): ProjectMode {
  return override ?? projectDefault ?? "agent";
}

/** Only a mode that differs from the project's default is sent as an override (the default applies anyway). */
export function modeToSend(override: ProjectMode | null, projectDefault: ProjectMode | undefined): ProjectMode | null {
  return override !== null && override !== (projectDefault ?? "agent") ? override : null;
}
