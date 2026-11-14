import { Suspense, lazy } from "react";
import { GLYPH } from "../primitives/glyphs";
import { Presence } from "../primitives/Presence";
import { Chip } from "../primitives/Chip";
import { useChipMenu, type ChipProps } from "./ComposerChips";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));

/** Decision 96: which main session the composer sends to (its title; "default" when it is the project's default one). */
export type ComposerSession = { title: string; isDefault: boolean; onMakeDefault?: (() => void) | undefined; onShowAll(): void };

/**
 * Criterion 34: the composer always says which session it sends to. A quiet chip at the top of the box; its menu makes the
 * session the default and leads to the project's sessions. (A worktree session's branch joins the label with phase 3.)
 */
export function SessionChip(props: ChipProps & { session: ComposerSession }) {
  const { ref, open, setOpen, at } = useChipMenu(props.onOpenChange);
  const pos = open ? at() : null;
  const { session } = props;
  const make = session.onMakeDefault;
  return (
    <>
      <Chip
        ref={ref}
        icon={GLYPH.sessions}
        name="Sends to session"
        label={session.isDefault ? `${session.title} · default` : session.title}
        tip={`Sends to the session "${session.title}"${session.isDefault ? ", the project's default" : ""}`}
        bare={props.bare}
        open={open}
        disabled={props.disabled}
        aria-haspopup="menu"
        data-chip="session"
        onClick={() => setOpen(!open)}
        className="max-w-full"
      />
      <Presence show={pos !== null} exitMs={0}>
        {pos && (
          <Suspense fallback={null}>
            <Menu
              label="Session"
              x={pos.x}
              y={pos.y}
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
    </>
  );
}
