import { orchestratorGlyph } from "../../lib/stateGlyph";
import { StateGlyph } from "./StateGlyph";
import { spinnerBox, type ControlSize } from "../../lib/controls";

/**
 * Loading (transient work: a file opening, a server starting) uses the same working ring as everything else
 * (decision 29: no other spinner shape exists). `className` replaces the default colour (`text-fg-2`).
 * `size` is the control size it sits in (xs/sm 12, md 14, lg 16: one ring per control size); a pixel number is the old
 * spelling and is deprecated. Animated by definition: show it only while the work runs (decision 76).
 */
export function Spinner({ size = 12, className = "text-fg-2" }: { size?: ControlSize | number; className?: string }) {
  const box = spinnerBox(size);
  return <StateGlyph state="working" size={box >= 14 ? 14 : 12} box={box} className={className} />;
}

/** Something is running: the working ring centred in a `box`-sized square. */
export function RunningDot({ box = 12, className }: { box?: number; className?: string }) {
  return <StateGlyph state="working" size={box >= 16 ? 14 : 12} box={box} {...(className === undefined ? {} : { className })} />;
}

/**
 * The orchestrator's state in one 16px slot (sidebar rows, Home, the header): its ring at 14px — working (turning arc),
 * needs you (pulsing dot, `warn`), unseen activity (accent disc), not started (dashed), idle (thin ring).
 */
export function OrchestratorGlyph({ state, unseen = false }: { state: "working" | "needs" | "idle" | "new"; unseen?: boolean }) {
  return <StateGlyph state={orchestratorGlyph(state, unseen)} size={14} box={16} label />;
}
