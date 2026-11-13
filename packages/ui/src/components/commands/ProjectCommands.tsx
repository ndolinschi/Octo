import { useLayoutEffect, useRef, useState } from "react";
import { menuOrder } from "../../lib/commands/config";
import { runningRuns } from "../../lib/projectRuns";
import { cn } from "../../lib/cn";
import { settingsHref } from "../../lib/route";
import { useProject } from "../../state/project";
import { useRunsSelector, useRunsStore } from "../../state/projectRuns";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Minimize2, Play } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { MOD_LABEL } from "../../lib/keys";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import type { MenuItem } from "../primitives/Menu";
import { MenuButton } from "../primitives/MenuButton";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { startProjectRun } from "./startRun";
import { useCommandsApi } from "./useCommandsApi";

function openCommandSettings() {
  window.location.hash = settingsHref("commands");
}

/** Decision 68: at most two pinned commands sit in the top row. */
const PINNED_SHOWN = 2;

/**
 * The project's commands in the top row (decision 68), next to the project actions: the pinned ones as quiet buttons (a
 * spinner while that command runs) and a "Run" menu with all of them. Running one starts it in the project folder and shows
 * its "Run: name" tab; clicking one that runs just shows the tab. Only the user starts a command, never an agent.
 */
export default function ProjectCommands({
  onRestore,
  hideCommands = false,
  collapsePinned = false,
  onPinnedWidth,
}: {
  /** Set while the strip's group has the whole dock (decision 78). */ onRestore: (() => void) | null;
  /** A review is the active tab: its header has the commands (decision 90), so none are shown here. */ hideCommands?: boolean;
  /** The tabs need the room (decision 90): the pinned buttons are only in the "Run" menu. */ collapsePinned?: boolean;
  /** The width the pinned buttons take (with their gap), so the strip can decide before it folds them; 0 when none show. */ onPinnedWidth?: (
    w: number,
  ) => void;
}) {
  const pinnedBox = useRef<HTMLSpanElement>(null);
  const api = useCommandsApi();
  const store = useRunsStore();
  const ws = useOptionalWorkspace();
  const { project } = useProject();
  const [problem, setProblem] = useState<string | null>(null);
  const busyKey = useRunsSelector((s) =>
    runningRuns(s)
      .map((r) => r.name.toLowerCase())
      .join("\n"),
  );
  const restore = onRestore && (
    <IconButton
      icon={Minimize2}
      label="Restore the layout"
      title={`Restore the other panels (Esc, ${MOD_LABEL}Shift+Enter)`}
      data-restore-layout
      className="shrink-0"
      onClick={onRestore}
    />
  );
  const hidden = hideCommands || !api || !store || !project;
  const pinnedCount = hidden
    ? 0
    : menuOrder(project.commands ?? [])
        .filter((c) => c.pinned)
        .slice(0, PINNED_SHOWN).length;
  useLayoutEffect(() => {
    const box = pinnedBox.current;
    const report = () => onPinnedWidth?.(box && pinnedCount > 0 ? box.getBoundingClientRect().width + (box.getBoundingClientRect().width > 0 ? 4 : 0) : 0);
    report();
    if (!box) return;
    const ro = new ResizeObserver(report);
    ro.observe(box);
    return () => ro.disconnect();
  }, [pinnedCount, onPinnedWidth]);
  if (!api || !store || !project) return restore || null;
  if (hideCommands) return restore || null;
  const busy = new Set(busyKey ? busyKey.split("\n") : []);
  const commands = menuOrder(project.commands ?? []);
  const pinned = commands.filter((c) => c.pinned).slice(0, PINNED_SHOWN);

  const run = async (name: string) => {
    if (busy.has(name.toLowerCase())) return ws?.openRun(name);
    const r = await startProjectRun(api, store, name);
    if ("problem" in r) setProblem(r.problem);
    else ws?.openRun(name);
  };
  const items: MenuItem[] = [
    ...commands.map((c): MenuItem => ({
      id: `run:${c.name}`,
      label: busy.has(c.name.toLowerCase()) ? `${c.name} (running)` : c.name,
      title: c.command,
      run: () => void run(c.name),
    })),
    ...(commands.length > 0 ? [{ id: "sep", separator: true } as const] : []),
    {
      id: "settings",
      label: commands.length > 0 ? "Edit commands in Settings" : "Add commands in Settings",
      run: openCommandSettings,
    },
  ];
  return (
    <>
      <span className="flex min-w-0 shrink-0 items-center gap-1">
        {restore}
        <span
          ref={pinnedBox}
          aria-hidden={collapsePinned || undefined}
          inert={collapsePinned}
          className={cn("flex items-center gap-1 max-lg:hidden", collapsePinned && "pointer-events-none invisible absolute")}
        >
          {/* Decision 94c: a pinned command is a quiet button that looks like something that runs: a play glyph and the name,
              set off from the tabs by a divider; while it runs the glyph is the spinner and a click opens its run tab. */}
          {pinned.length > 0 && <span aria-hidden className="mr-1 h-4 w-px shrink-0 bg-line" />}
          {pinned.map((c) => {
            const running = busy.has(c.name.toLowerCase());
            return (
              <Button
                key={c.name}
                variant="quiet"
                size="sm"
                title={running ? `${c.name} is running: open its tab` : `Run: ${c.command}`}
                aria-busy={running}
                onClick={() => void run(c.name)}
                className="max-w-40"
              >
                {/* The glyph has its own place, so the strip (and the tabs in it) never changes width when a run starts or ends. */}
                <span aria-hidden className="grid size-4 place-items-center">
                  {running ? <Spinner /> : <Glyph icon={Play} size={14} />}
                </span>
                <span className="truncate">{c.name}</span>
              </Button>
            );
          })}
        </span>
        <MenuButton label="Run a project command" text="Run" alignEnd items={items} />
      </span>
      <Presence show={problem !== null}>
        {problem !== null && (
          <Dialog
            width="sm"
            title="The command did not start"
            description={problem}
            onClose={() => setProblem(null)}
            footer={
              <Button onClick={() => setProblem(null)} data-autofocus>
                Close
              </Button>
            }
          >
            {null}
          </Dialog>
        )}
      </Presence>
    </>
  );
}
