import { useEffect } from "react";

/** Below this, a shrunk visual viewport is browser chrome (an address bar), not the on-screen keyboard. */
const KEYBOARD_MIN = 80;

/**
 * Direction 7: the on-screen keyboard. The app's frame follows the visual viewport (`--octo-vvh`, `--octo-vv-top` on the root
 * element; `styles.css` places `[data-app-root]` with them), so the composer stays visible right above the keyboard while the
 * conversation keeps its scroll position; `--octo-kb` (the keyboard's height) lifts bottom sheets; `data-keyboard` drops the
 * bottom safe-area inset while it is up. Pinch-zoom (scale ≠ 1) leaves the frame alone. Without `visualViewport` (old
 * engines) nothing is set and the CSS falls back to `100dvh`.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const clear = () => {
      for (const p of ["--octo-vvh", "--octo-vv-top", "--octo-kb"]) root.style.removeProperty(p);
      root.removeAttribute("data-keyboard");
    };
    const update = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return clear();
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty("--octo-vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--octo-vv-top", `${Math.round(vv.offsetTop)}px`);
      root.style.setProperty("--octo-kb", `${kb}px`);
      root.toggleAttribute("data-keyboard", kb > KEYBOARD_MIN);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      clear();
    };
  }, []);
}
