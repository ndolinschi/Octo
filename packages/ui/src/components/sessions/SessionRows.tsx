import type { ProjectSession } from "@octo/agent-client";
import type { KeyboardEvent } from "react";
import { canDelete, sessionRow, type SessionNode } from "../../lib/sessions/model";
import { useModelNames } from "../../state/modelNames";
import { IconMenu } from "../primitives/IconMenu";
import { ListRow } from "../primitives/ListRow";
import type { MenuItem } from "../primitives/Menu";
import { StateGlyph } from "../primitives/StateGlyph";
import { ROW_TAIL, RowLine } from "./parts";

/**
 * The rows of the Sessions list, Memory's anatomy: state glyph, title, a dim "Nov 12 · 5 exchanges · Opus 5.5" and at its right
 * "current" or the last activity. A main session with agent sessions opens under itself (`aria-expanded`; one open at a time,
 * →/← open and close, ← on an agent row goes to its main session); agent rows sit one step in.
 */
export function SessionRows(props: {
  nodes: readonly SessionNode[];
  selected: string | null;
  open: string | null;
  /** Every node with agents shows them (the Working filter exists to show them). */
  openAll: boolean;
  now: number;
  onChoose(session: ProjectSession): void;
  /** →/← on a main row: open or close it without choosing it (a choice would open the detail in a one-column pane). */
  onToggle(session: ProjectSession): void;
  /** The "⋯" of a row: Resume, Archive and Delete. Without it rows only reserve the room. */
  menu?: {
    list: readonly ProjectSession[];
    onResume(session: ProjectSession): void;
    onArchive(session: ProjectSession, archived: boolean): void;
    onDelete(session: ProjectSession): void;
  };
}) {
  const { name } = useModelNames();
  const rows = (s: ProjectSession, expanded?: boolean) => {
    const r = sessionRow(s, props.now, name);
    const menu = props.menu;
    const items: MenuItem[] = [];
    if (menu) {
      if (s.kind === "main" && !s.current) items.push({ id: "resume", label: "Resume", run: () => menu.onResume(s) });
      if (!s.current) items.push({ id: "archive", label: s.archived ? "Unarchive" : "Archive", run: () => menu.onArchive(s, !s.archived) });
      if (canDelete(menu.list, s)) items.push({ id: "delete", label: "Delete", run: () => menu.onDelete(s) });
    }
    return (
      <ListRow
        size="md"
        selected={s.id === props.selected}
        leading={<StateGlyph state={r.glyph} />}
        title={
          <>
            <span className="sr-only">{r.state}: </span>
            {r.title}
          </>
        }
        description={<RowLine end={r.tail}>{r.description}</RowLine>}
        tip={r.title}
        {...(expanded === undefined ? {} : { expanded })}
        onClick={() => props.onChoose(s)}
        trailing={items.length > 0 ? <IconMenu label={`Actions for ${r.title}`} size="xs" items={items} /> : ROW_TAIL}
      />
    );
  };
  return (
    <ul aria-label="Sessions" className="flex flex-col">
      {props.nodes.map((n) => {
        const expandable = n.children.length > 0;
        const shown = expandable && (props.openAll || props.open === n.session.id);
        return (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- →/← on the main row open and close it; the row's button is the focusable element
          <li key={n.session.id} data-session={n.session.id} onKeyDown={(e) => keys(e, n, props.open === n.session.id, props.onToggle)}>
            {rows(n.session, expandable ? shown : undefined)}
            {shown && (
              <ul aria-label={`Agents of ${n.session.title}`} className="flex flex-col pl-4">
                {n.children.map((c) => (
                  <li key={c.id} data-session={c.id}>
                    {rows(c)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Right opens a closed main row and Left closes an open one (a click on a row also chooses it; the keys only fold or unfold it).
 * Left on an agent row moves focus to its main row.
 */
function keys(e: KeyboardEvent<HTMLElement>, n: SessionNode, open: boolean, toggle: (s: ProjectSession) => void) {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  const first = e.currentTarget.querySelector<HTMLElement>("[data-row]");
  if (!target || !first) return;
  if (target === first && n.children.length > 0) {
    if ((e.key === "ArrowRight") === open) return;
    e.preventDefault();
    toggle(n.session);
  } else if (target !== first && e.key === "ArrowLeft") {
    e.preventDefault();
    first.focus();
  }
}
