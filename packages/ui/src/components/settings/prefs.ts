import { useEffect } from "react";
import { choiceCodec, loadPref, PREFS, usePersistentState } from "../../lib/storage";

/**
 * Preferences of Settings → General / Appearance that the app shell reads at start (this module stays small: the
 * settings page itself is a lazy chunk).
 */
export const startupCodec = choiceCodec(["last", "home"] as const, "last");
export const motionCodec = choiceCodec(["system", "reduced"] as const, "system");

/** Whether opening the app (no route) may jump to the last project; "home" keeps Home. */
export function startupOpensLast(): boolean {
  return loadPref(PREFS.startup, startupCodec) === "last";
}

/** `data-motion="reduced"` on the root turns transitions and animations off (the `settings` block of styles.css). */
export function applyMotion(value: "system" | "reduced"): void {
  if (value === "reduced") document.documentElement.dataset.motion = "reduced";
  else delete document.documentElement.dataset.motion;
}

/** Applies the stored motion preference once, at start. */
export function useStoredMotion(): void {
  useEffect(() => applyMotion(loadPref(PREFS.motion, motionCodec)), []);
}

export function useMotionPref() {
  const [value, set] = usePersistentState(PREFS.motion, motionCodec);
  useEffect(() => applyMotion(value), [value]);
  return [value, set] as const;
}
