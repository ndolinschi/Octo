import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SlashCommands } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { disabledSlashCommands, type SlashRow } from "../../lib/slash";
import { slashGroups } from "../../lib/slashRows";
import type { PickerSection } from "../../lib/picker";
import { useTabFlags } from "../../state/tabFlags";
import { Highlight } from "../primitives/Highlight";
import { PopupList, popupOptionId, POPUP_PANEL } from "../primitives/PopupList";
import { popupMove } from "../primitives/popupNav";
import { useCloseOnScroll } from "../primitives/popupScroll";
import { useLatest } from "../../lib/hooks";
import { usePhone } from "../../lib/phone";
import { MODE_LABEL } from "../../lib/modeLabels";
import { MODES } from "../../lib/modes";

/** "ask|plan|agent" reads "Agent, Ask or Plan"; any other argument hint stays as it is. */
function argsText(args: string): string {
  const parts = args.split("|");
  if (parts.length < 2 || !parts.every((p) => p in MODE_LABEL)) return args;
  const names = MODES.filter((m) => parts.includes(m)).map((m) => MODE_LABEL[m]);
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

const describe = (row: SlashRow) => (row.available ? row.description : `${row.description}. ${row.reason ?? "Not available right now."}`);

export type SlashMenuHandle = { onKeyDown(e: KeyboardEvent): boolean };

/**
 * B11: the one menu `/` opens at the start of the composer. Two groups (Octo's commands, then the agent's under its
 * name), fuzzy-filtered by what is typed; ↑ ↓ (and Ctrl+Home / Ctrl+End) move, Enter and Tab choose, Esc closes (the composer
 * forwards the keys: the focus stays in the text, so plain Home / End move its caret; decision 95, `popupNav`). A command that is
 * not available stays, dim, with the reason. Resizing the window closes it, as `Menu` and `Popover` do (B9).
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
    onChoose(row: SlashRow, how: "run" | "complete"): void;
    onClose(): void;
  }
>(function SlashMenu(props, handle) {
  const tabFlags = useTabFlags();
  const disabled = disabledSlashCommands(tabFlags);
  const { groups, rows } = slashGroups(props.commands, props.query, disabled);
  const [selected, setSelected] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom?: number; top?: number; width: number; maxHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { box } = props;
  const close = useLatest(props.onClose);
  // Fixed and in a portal (the composer's own ancestors clip), measured from the box. A window resize closes it, as it closes
  // `Menu` and `Popover` (B9): the box moves after the resize (the sidebar folds), so a measure on `resize` was stale.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) {
      const below = r.top < 140 && window.innerHeight - r.bottom > r.top;
      const maxHeight = Math.max(120, below ? window.innerHeight - r.bottom - 14 : r.top - 14);
      setPos(
        below
          ? { left: r.left, top: r.bottom + 6, width: r.width, maxHeight }
          : { left: r.left, bottom: window.innerHeight - r.top + 6, width: r.width, maxHeight },
      );
    }
    const onResize = () => close.current();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !box.current?.contains(t)) close.current();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [box, close]);
  useCloseOnScroll(true, panelRef, () => box.current, props.onClose);
  const enabled = rows.filter((r) => r.available);
  const activeRow = enabled.find((r) => r.id === selected) ?? enabled[0] ?? null;
  const { onActive, listId } = props;
  const activeId = activeRow?.id ?? null;
  useEffect(() => onActive(activeId === null ? null : popupOptionId(listId, activeId)), [activeId, onActive, listId]);
  const allGroups = props.query ? slashGroups(props.commands, "", disabled).groups : groups;
  // A name that both Octo and the agent offer says whose it is on the agent's row ("/review · Claude Code").
  const octoNames = new Set(allGroups.filter((g) => g.rows[0]?.group === "octo").flatMap((g) => g.rows.map((r) => r.name)));
  const labelFor = (row: SlashRow, group: string) => (row.group === "agent" && octoNames.has(row.name) ? `/${row.name} · ${group}` : `/${row.name}`);
  const maxName = allGroups.reduce((m, g) => g.rows.reduce((n, r) => Math.max(n, labelFor(r, g.label).length), m), 0);
  const nameCol = `min(${Math.min(18, Math.max(8, maxName))}ch, 35%)`;
  // 5a: on the phone the description is a second line (styles.css lets it take two) and the argument hint goes: it repeated the
  // description ("Choose Agent, Ask or Plan" · "Agent, Ask or Plan") and both were cut at 390.
  const phone = usePhone();
  const sections: PickerSection[] = groups.map((g) => ({
    title: g.label,
    rows: g.rows.map((row) => {
      const label = labelFor(row, g.label);
      const detail = describe(row);
      const hint = row.args && !phone ? argsText(row.args) : undefined;
      const muted = activeId === row.id ? "text-fg-2" : "text-fg-3";
      return {
        id: row.id,
        label,
        ...(phone
          ? { sub: detail }
          : {
              content: (
                <span
                  className="grid min-w-0 flex-1 items-center gap-3"
                  style={{ gridTemplateColumns: hint ? `${nameCol} minmax(0, 1fr) auto` : `${nameCol} minmax(0, 1fr)` }}
                >
                  <span className="truncate">
                    <Highlight text={label} query={props.query} />
                  </span>
                  <span className={cn("min-w-0 truncate text-xs", muted)}>{detail}</span>
                  {hint && <span className={cn("max-w-40 truncate text-xs", muted)}>{hint}</span>}
                </span>
              ),
            }),
        disabled: !row.available,
        run: () => props.onChoose(row, "run"),
      };
    }),
  }));
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
          if (!activeRow) return false;
          props.onChoose(activeRow, e.key === "Tab" ? "complete" : "run");
          return true;
        }
        const to = popupMove(
          e,
          true,
          enabled.map((r) => r.id),
          activeId,
        );
        if (to === null) return false;
        setSelected(to);
        return true;
      },
    }),
    [rows, enabled, activeRow, activeId, props],
  );
  if (!pos) return null;
  return createPortal(
    // The text keeps focus: the list stops mouse presses from blurring it.
    <div ref={panelRef} data-slash-menu style={pos} className={POPUP_PANEL}>
      <PopupList
        id={props.listId}
        label="Commands"
        sections={sections}
        activeId={activeId}
        onActive={setSelected}
        onChoose={(r) => r.run()}
        query={props.query}
        empty="No command matches. Press Enter to send it as typed."
      />
    </div>,
    document.body,
  );
});
