import { MOD_LABEL } from "../../lib/keys";
import type { PaletteWorkspace, WorkspaceCommand } from "../nav";
import { tabButton } from "./ids";
import * as L from "./layout";
import type { TabId } from "./layout";

/* The open workspace's rows of the palette (its tab actions and its tabs): built only when the palette opens, so this module
 * loads with the palette's chunk and not with the app. */

const label = (tab: TabId) => tabButton(document, tab)?.dataset.label ?? tab;

/** The tool tabs and the actions on the focused tab that apply now (move, split, close…). */
export function workspaceActions(ws: PaletteWorkspace): WorkspaceCommand[] {
  const layout = ws.layout;
  const active = L.focusedGroup(layout).active;
  const name = label(active);
  const out: WorkspaceCommand[] = [
    { id: "tool-sessions", label: "Show sessions", detail: "conversations and agent sessions", run: () => ws.openTool("sessions") },
    { id: "tool-agents", label: "Show agents", run: () => ws.openTool("agents") },
    { id: "tool-notes", label: "Show notes", run: () => ws.openTool("notes") },
    { id: "tool-files", label: "Show files", run: () => ws.openTool("files") },
    { id: "tool-details", label: "Show project details", run: () => ws.openTool("details") },
    { id: "tool-changes", label: "Show changes", detail: "what the agents changed", run: () => ws.openTool("changes") },
    { id: "tool-review", label: "Review a pull request", detail: "pick one, read it, comment, submit", run: () => ws.openTool("review") },
    { id: "tool-memory", label: "Show memory", detail: "what the project remembers", run: () => ws.openTool("memory") },
    { id: "tool-usage", label: "Show usage", detail: "tokens, cost, limits", run: () => ws.openTool("usage") },
    { id: "tool-side", label: "Ask a side question", detail: "not added to the conversation", shortcut: `${MOD_LABEL};`, run: () => ws.openTool("side") },
    { id: "new-tab", label: "Open a tab…", detail: "tools, files, agents", shortcut: `${MOD_LABEL}T`, run: () => ws.openPicker() },
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
