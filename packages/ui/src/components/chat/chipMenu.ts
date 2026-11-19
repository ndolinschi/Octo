import { useRef, useState } from "react";

// The mode and access chips' menu (their own chunks): apart from `ComposerChips`, which the entry imports.

/** Gap between a chip and the menu it opens (decision 56). */
const MENU_GAP = 4;

export function useChipMenu(onOpenChange: (open: boolean) => void) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
  };
  const at = () => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top - MENU_GAP } : { x: 0, y: 0 };
  };
  return { ref, open, setOpen, at };
}
