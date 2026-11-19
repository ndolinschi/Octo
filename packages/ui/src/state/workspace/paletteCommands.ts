import { MOD_LABEL } from "../../lib/keys";
import { TOOL_PURPOSE, type PurposeTool } from "../../lib/toolPurpose";
import type { PaletteWorkspace, WorkspaceCommand } from "../nav";
import { tabButton } from "./ids";
import * as L from "./layout";
import type { TabId, ToolTab } from "./layout";

/**
 * The tool purposes, short (here, in the palette's chunk, not beside `TOOL_PURPOSE` in the entry): the detail of the palette's "Show …" rows. Shell polish, item 12: each a short sentence, one name
 * per thing (a session is a session, an agent an agent).
 */
const TOOL_HINT = {
  sessions: "Your sessions and their agents.",
  agents: "What each agent is doing.",
  notes: "Decisions and facts agents read.",
  files: "Open a file to read or edit it.",
  browser: "Preview a page and mark it up for Chat.",
  terminal: "A shell in the project's folder.",
  processes: "Running commands and their output.",
  details: "Folders, models, usage and activity.",
  changes: "What the agents changed.",
  review: "Read a pull request and review it.",
  memory: "What Octo remembers about the project.",
  usage: "Tokens, cost and limits.",
  side: "Ask without adding to the session.",
} as const satisfies Record<PurposeTool, string>;

/* The open workspace's rows of the palette (its tab actions and its tabs): built only when the palette opens, so this module
 * loads with the palette's chunk and not with the app. */

const label = (ws: PaletteWorkspace, tab: TabId) => tabButton(document, tab)?.dataset.label ?? ws.tabName?.(tab) ?? tab;

/** The tool tabs and the actions on the focused tab that apply now (move, split, close…). */
export function workspaceActions(ws: PaletteWorkspace): WorkspaceCommand[] {
  const layout = ws.layout;
  const active = L.focusedGroup(layout).active;
  const name = label(ws, active);
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
    { id: "new-tab", label: "Open a tab…", detail: "A tool, session, file or agent.", shortcut: `${MOD_LABEL}T`, run: () => ws.openPicker() },
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
    return g.tabs.map((t) => ({ id: `tab:${t}`, label: label(ws, t), ...(where === undefined ? {} : { detail: where }), run: () => ws.activate(t) }));
  });
}
