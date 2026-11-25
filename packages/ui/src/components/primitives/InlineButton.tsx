import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

/** The keys that press a button: Enter and Space (WAI-ARIA button pattern). */
export function pressesButton(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/**
 * Runs `press` for Enter or Space and keeps Space from scrolling the page; any other key passes through. A held key
 * (`repeat`) presses once.
 */
export function onPressKey(e: Pick<KeyboardEvent, "key" | "repeat" | "preventDefault">, press: () => void): void {
  if (!pressesButton(e.key)) return;
  e.preventDefault();
  if (!e.repeat) press();
}

/**
 * A button that flows with the text around it (a file chip in prose). A native `<button>` is an atomic inline: it never
 * breaks inside and drags the punctuation before it onto its own line ("after 10 s (" / chip). This is a `<span
 * role="button">` that wraps like text, takes focus, and presses with a click, Enter or Space. It has no look of its own:
 * the caller's class styles it; the focus ring is the global one.
 *
 * Not for: a control in a toolbar, a row or a form (`Button`, `IconButton`, `ListRow`).
 */
export function InlineButton({
  onPress,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, "role" | "tabIndex" | "onClick" | "onKeyDown"> & { onPress(): void; children: ReactNode }) {
  return (
    <span role="button" tabIndex={0} onClick={onPress} onKeyDown={(e) => onPressKey(e, onPress)} {...rest}>
      {children}
    </span>
  );
}
