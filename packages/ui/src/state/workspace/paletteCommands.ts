import { MOD_LABEL } from "../../lib/keys";
import { TOOL_HINT, TOOL_PURPOSE, type PurposeTool } from "../../lib/toolPurpose";
import type { PaletteWorkspace, WorkspaceCommand } from "../nav";
import { tabButton } from "./ids";
import * as L from "./layout";
import type { TabId, ToolTab } from "./layout";

/* The open workspace's rows of the palette (its tab actions and its tabs): built only when the palette opens, so this module
 * loads with the palette's chunk and not with the app. */

const label = (tab: TabId) => tabButton(document, tab)?.dataset.label ?? tab;

/** The tool tabs and the actions on the focused tab that apply now (move, split, close…). */
export function workspaceActions(ws: PaletteWorkspace): WorkspaceCommand[] {
  const layout = ws.layout;
  const active = L.focusedGroup(layout).active;
  const name = label(active);
  // Item 9: a tool row's detail and search text are the tool's purpose (`lib/toolPurpose`, the panels' (i) says the same).
  const tool = (t: PurposeTool & ToolTab, text: string): WorkspaceCommand => ({
    id: `tool-${t}`,
    label: text,
    detail: TOOL_HINT[t],
    search: `${TOOL_HINT[t]} ${TOOL_PURPOSE[t]}`,
    run: () => ws.openTool(t),
  });
  const out: WorkspaceCommand[] = [
    tool("sessions", "Show sessions"),
    tool("agents", "Show agents"),
    tool("notes", "Show notes"),
    tool("files", "Show files"),
    tool("browser", "Show browser"),
    tool("details", "Show project details"),
    tool("changes", "Show changes"),
    tool("review", "Review a pull request"),
    ...(ws.memoryBlocked ? [] : [tool("memory", "Show memory")]),
    tool("usage", "Show usage"),
    { ...tool("side", "Ask a side question"), shortcut: `${MOD_LABEL};` },
    { id: "new-tab", label: "Open a tab…", detail: "tools, sessions, files, agents", shortcut: `${MOD_LABEL}T`, run: () => ws.openPicker() },
  ];
  if (ws.canMoveToOtherSide(active))
    out.push({ id: "move", label: "Move tab to the other side", detail: name, shortcut: `${MOD_LABEL}\\`, run: () => ws.moveToOtherSide(active) });
  if (ws.canSplitRight(active)) out.push({ id: "split", label: "Split right", detail: name, run: () => ws.splitRight(active) });
  if (L.closable(active)) out.push({ id: "close", label: "Close tab", detail: name, shortcut: `${MOD_LABEL}W`, run: () => ws.requestClose([active]) });
  if (L.allTabs(layout).length > 1) out.push({ id: "close-others", label: "Close other tabs", detail: name, run: () => ws.closeOthers(active) });
  if (layout.groups.length > 1 && !ws.narrow) out.push({ id: "equalize", label: "Make groups equal width", run: () => ws.equalize() });
  return out;
}

/** One row per open tab, with its side when the dock has several groups. */
export function workspaceTabs(ws: PaletteWorkspace): WorkspaceCommand[] {
  const groups = ws.layout.groups;
  const side = (i: number) => (groups.length === 1 ? undefined : i === 0 ? "left" : i === groups.length - 1 ? "right" : "middle");
  return groups.flatMap((g, i) => {
    const where = side(i);
    return g.tabs.map((t) => ({ id: `tab:${t}`, label: label(t), ...(where === undefined ? {} : { detail: where }), run: () => ws.activate(t) }));
  });
}
