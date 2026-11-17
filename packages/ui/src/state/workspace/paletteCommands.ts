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
  const enabled = (t: ToolTab) => (ws.toolEnabled ? ws.toolEnabled(t) : !(t === "memory" && ws.memoryBlocked));
  const maybeTool = (t: PurposeTool & ToolTab, text: string, shortcut?: string): WorkspaceCommand[] =>
    enabled(t) ? [{ ...tool(t, text), ...(shortcut ? { shortcut } : {}) }] : [];
  const out: WorkspaceCommand[] = [
    ...maybeTool("sessions", "Show sessions"),
    ...maybeTool("agents", "Show agents"),
    ...maybeTool("notes", "Show notes"),
    ...maybeTool("files", "Show files"),
    ...maybeTool("browser", "Show browser"),
    ...maybeTool("terminal", "Open terminal", `${MOD_LABEL}\``),
    ...maybeTool("processes", "Show processes"),
    ...maybeTool("details", "Show project details"),
    ...maybeTool("changes", "Show changes"),
    ...maybeTool("review", "Review a pull request"),
    ...maybeTool("memory", "Show memory"),
    ...maybeTool("usage", "Show usage"),
    ...maybeTool("side", "Ask a side question", `${MOD_LABEL};`),
    { id: "new-tab", label: "Open a tab…", detail: "tools, sessions, files, agents", shortcut: `${MOD_LABEL}T`, run: () => ws.openPicker() },
  ];
  if (ws.canMoveToOtherSide(active))
    out.push({ id: "move", label: "Move tab to the other side", detail: name, shortcut: `${MOD_LABEL}\\`, run: () => ws.moveToOtherSide(active) });
  if (ws.canSplitRight(active)) out.push({ id: "split", label: "Split right", detail: name, run: () => ws.splitRight(active) });
  if (ws.canClose ? ws.canClose(active) : L.closable(active))
    out.push({ id: "close", label: "Close tab", detail: name, shortcut: `${MOD_LABEL}W`, run: () => ws.requestClose([active]) });
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
