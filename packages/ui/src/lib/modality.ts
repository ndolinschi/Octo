import { useEffect } from "react";

/**
 * Records how the user last interacted (`<html data-input="keyboard|pointer">`). Overlays opened
 * from the keyboard (Ctrl/Cmd+K, Shift+F10…) skip their enter/exit animation; see styles.css.
 */
export function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (mode: string) => () => {
      if (root.dataset.input !== mode) root.dataset.input = mode;
    };
    const key = set("keyboard");
    const pointer = set("pointer");
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
}
