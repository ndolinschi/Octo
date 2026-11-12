import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SlashCommands } from "@octo/agent-client";
import { slashGroups, type SlashRow } from "../../lib/slash";
import { listKeyTarget } from "../../lib/focus";
import { Card } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";

export type SlashMenuHandle = { onKeyDown(e: KeyboardEvent): boolean };

/**
 * B11: the one menu `/` opens at the start of the composer. Two groups (Octo's commands, then the agent's under its
 * name), fuzzy-filtered by what is typed; ↑ ↓ move, Enter and Tab choose, Esc closes (the composer forwards the keys: the
 * focus stays in the text). A command that is not available stays, dim, with the reason.
 */
export const SlashMenu = forwardRef<
  SlashMenuHandle,
  {
    commands: SlashCommands | null;
    /** The composer box: the menu floats above it, as wide. */
    box: RefObject<HTMLElement | null>;
    query: string;
    listId: string;
    onActive(id: string | null): void;
    onChoose(row: SlashRow): void;
    onClose(): void;
  }
>(function SlashMenu(props, handle) {
  const { groups, rows } = slashGroups(props.commands, props.query);
  const [selected, setSelected] = useState(0);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const { box } = props;
  // Fixed and in a portal (the composer's own ancestors clip), measured from the box and kept there on resize.
  useLayoutEffect(() => {
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 6, width: r.width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [box]);
  const at = rows.length ? Math.min(selected, rows.length - 1) : -1;
  const { onActive } = props;
  useEffect(() => onActive(at >= 0 ? `${props.listId}-${at}` : null), [at, onActive, props.listId]);
  useImperativeHandle(
    handle,
    () => ({
      onKeyDown: (e) => {
        if (e.key === "Escape") {
          props.onClose();
          return true;
        }
        if (!rows.length) return false;
        if (e.key === "Enter" || e.key === "Tab") {
          const row = rows[at];
          if (row?.available) props.onChoose(row);
          return true;
        }
        const to = e.key === "ArrowDown" || e.key === "ArrowUp" ? listKeyTarget(e.key, at, rows.length) : null;
        if (to === null) return false;
        setSelected(to);
        return true;
      },
    }),
    [rows, at, props],
  );
  let index = -1;
  if (!pos) return null;
  return createPortal(
    // The text keeps focus: a mouse press on a row must not blur it.
    <div data-slash-menu onMouseDown={(e) => e.preventDefault()} style={pos} className="fixed z-[60]">
      <Card surface="raised" padding="none" className="max-h-72 overflow-y-auto shadow-pop">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-sm text-fg-3">No command matches. Press Enter to send it as typed.</p>
        ) : (
          <div id={props.listId} role="listbox" aria-label="Commands" className="p-1">
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <SectionHeader inset as="h3">
                  {g.label}
                </SectionHeader>
                {g.rows.map((row) => {
                  index += 1;
                  const i = index;
                  return (
                    <ListRow
                      key={row.id}
                      id={`${props.listId}-${i}`}
                      role="option"
                      active={i === at}
                      disabled={!row.available}
                      title={
                        <>
                          <span className="font-mono">/{row.name}</span>
                          {row.args && <span className="ml-1.5 font-mono text-xs text-fg-3">{row.args}</span>}
                        </>
                      }
                      description={row.available ? row.description : `${row.description}. ${row.reason ?? "Not available right now."}`}
                      onClick={() => props.onChoose(row)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>,
    document.body,
  );
});
