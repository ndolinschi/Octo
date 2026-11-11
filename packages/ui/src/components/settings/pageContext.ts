import { createRequiredContext } from "../../lib/context";

/** What the settings page gets from the app shell: the connect sheet (another feature) and a restart, when the host has one. */
export type SettingsActions = {
  /** Opens the connect sheet of a provider (`anthropic-api`, `octo-router`, an agent id) or of the router's upstream key. */
  connect(target: string): void;
  restart: (() => void) | undefined;
};

const ctx = createRequiredContext<SettingsActions>("useSettingsActions");
export const SettingsActionsProvider = ctx.Provider;
export const useSettingsActions = ctx.useRequired;
