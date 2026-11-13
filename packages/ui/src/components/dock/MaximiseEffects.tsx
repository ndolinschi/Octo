import { useEffect, useRef } from "react";
import { useLatest } from "../../lib/hooks";
import { useShell } from "../../state/shell";
import { focusedGroup } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * What only matters while a group has the whole dock (decision 78), mounted by `Dock` for exactly that time and loaded on
 * first use: the sidebar steps aside (and comes back when this unmounts, if it was open), and Esc restores the layout when
 * nothing else took the key — a bubble-phase listener, after menus, dialogs, the editor and fields that use Esc themselves
 * have had it, and never while the caret is in a text field.
 */
export default function MaximiseEffects() {
  const ws = useWorkspace();
  const wsRef = useLatest(ws);
  const shell = useShell();
  const shellRef = useLatest(shell);

  // Closes the sidebar once, from what the render shows (not from a ref that is a render behind: React's development
  // double-run of effects would toggle it twice), and gives it back when this unmounts.
  const closedByUs = useRef(false);
  const open = shell.sidebarOpen;
  useEffect(() => {
    if (open && !closedByUs.current) {
      closedByUs.current = true;
      shellRef.current.toggleSidebar();
    }
  }, [open, shellRef]);
  useEffect(
    () => () => {
      if (closedByUs.current && !shellRef.current.sidebarOpen) {
        closedByUs.current = false;
        shellRef.current.toggleSidebar();
      }
    },
    [shellRef],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)
      )
        return;
      e.preventDefault();
      wsRef.current.toggleMaximise(focusedGroup(wsRef.current.layout).active, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wsRef]);
  return null;
}
