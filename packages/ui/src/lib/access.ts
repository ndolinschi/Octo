import type { AccessMode } from "@octo/agent-client";

export const ACCESS_MODES: readonly AccessMode[] = ["supervised", "accept_edits", "full"];

export const ACCESS_LABEL: Record<AccessMode, string> = {
  supervised: "Ask",
  accept_edits: "Accept edits",
  full: "Allow all",
};

export const ACCESS_DETAIL: Record<AccessMode, string> = {
  supervised: "Asks before edits and commands",
  accept_edits: "Edits files freely, asks before commands",
  full: "Runs edits and commands without asking",
};
