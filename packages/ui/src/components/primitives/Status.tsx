import { StateGlyph } from "./StateGlyph";
import { spinnerBox, type ControlSize } from "../../lib/controls";

/**
 * Loading (transient work: a file opening, a server starting) uses the same working ring as everything else
 * (decision 29: no other spinner shape exists). `className` replaces the default colour (`text-fg-2`).
 * `size` is the control size it sits in (xs/sm 12, md 14, lg 16: one ring per control size); a pixel number is the old
 * spelling and is deprecated. Animated by definition: show it only while the work runs (decision 76).
 */
export function Spinner({ size = "sm", className = "text-fg-2", still }: { size?: ControlSize | number; className?: string; still?: boolean | undefined }) {
  const box = spinnerBox(size);
  return <StateGlyph state="working" size={box >= 14 ? 14 : 12} box={box} still={still} className={className} />;
}
