import { Suspense, lazy, useEffect, useState, type RefObject } from "react";
import { Presence } from "../primitives/Presence";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));

/** Decision 96: which main session the composer sends to (its title; "default" when it is the project's default one). */
export type ComposerSession = { title: string; isDefault: boolean; onMakeDefault?: (() => void) | undefined; onShowAll(): void };

/**
 * The session the composer sends to, opened from the "+" menu's "Session" entry (it was a chip of the control row): its menu makes
 * the session the default and leads to the project's sessions. (A worktree session's branch joins the label with phase 3.)
 */
export function SessionMenu(props: { anchor: RefObject<HTMLElement | null>; session: ComposerSession; onClose(): void }) {
  const [open, setOpen] = useState(true);
  const { onClose, session } = props;
  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);
  const r = props.anchor.current?.getBoundingClientRect();
  const make = session.onMakeDefault;
  return (
    <Presence show={open} exitMs={0}>
      {open && (
        <Suspense fallback={null}>
          <Menu
            label="Session"
            x={r ? r.left : 0}
            y={r ? r.top - 4 : 0}
            above
            onClose={() => setOpen(false)}
            items={[
              ...(make && !session.isDefault ? [{ id: "default", label: "Make default", run: make }] : []),
              { id: "all", label: "All sessions…", run: session.onShowAll },
            ]}
          />
        </Suspense>
      )}
    </Presence>
  );
}
