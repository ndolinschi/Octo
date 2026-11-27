import { Play, Plus, Settings, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { menuOrder } from "../../../lib/commands/config";
import { runningRuns } from "../../../lib/projectRuns";
import { navigate, settingsHref } from "../../../lib/route";
import { workingText } from "../../../lib/statusBar";
import { deviceMay, mayChangeProject, ON_YOUR_COMPUTER } from "../../../lib/remoteDevice";
import { useHost } from "../../../state/host";
import { useActivity } from "../../../state/activity";
import { useApp } from "../../../state/app";
import { useCode } from "../../../state/code";
import { useOptionalComments } from "../../../state/comments";
import { getBrowserTabPins, getBrowserTabState, useBrowserTabsRevision } from "../../../state/browserTabs";
import { getTerminalTabState, useTerminalTabsRevision } from "../../../state/terminalTabs";
import { getPlanTabState, usePlanTabsRevision } from "../../../state/planTabs";
import { useProject } from "../../../state/project";
import { useRunsSelector, useRunsStore } from "../../../state/projectRuns";
import { StatusSlotsContext } from "../../../state/statusSlots";
import { parseTab, toolTab, type TabId, type ToolTab } from "../../../state/workspace/layout";
import { TOOL_PURPOSE } from "../../../lib/toolPurpose";
import { useWorkspace } from "../../../state/workspace/WorkspaceProvider";
import type { FileKey } from "../../../lib/files";
import { startProjectRun } from "../../commands/startRun";
import { useCommandsApi } from "../../commands/useCommandsApi";
import { Glyph } from "../../primitives/Glyph";
import { ListRow } from "../../primitives/ListRow";
import { Notice } from "../../primitives/Notice";
import { Sheet } from "../../primitives/Sheet";
import { Spinner } from "../../primitives/Status";
import { StateGlyph } from "../../primitives/StateGlyph";
import { ProjectStatus } from "../../status/ProjectStatus";
import { RemoteIndicator } from "../../status/RemoteIndicator";
import { tabInfo, TOOL_TABS } from "../tabInfo";
import { runPhoneMoreCommand, runPhoneMoreCreateSession, type PhoneMoreAsyncHooks } from "./phoneMoreActions";

/** The panels the phone reaches from "⋯", in this order (direction 7). */
const PANELS: readonly ToolTab[] = [
  "files",
  "browser",
  "terminal",
  "processes",
  "changes",
  "sessions",
  "memory",
  "notes",
  "usage",
  "agents",
  "details",
  "side",
  "review",
];

/**
 * The phone header's "⋯" (direction 7): everything the desktop's top row and status bar carry, as one bottom sheet of 44px
 * rows in groups — this session (its open tabs, a new session), the project's commands, the panels, the status (changed
 * files, running commands, budget, agents at work in other projects, remote access) and the settings. Synchronous choices
 * close the sheet first (its history entry goes), then act; async actions ("New session", starting a command) stay open while
 * pending and close only on success so errors render inside the sheet.
 */
export default function PhoneMoreSheet(props: { active: TabId; tabs: TabId[]; sessionId: string | null; onClose(): void }) {
  const ws = useWorkspace();
  const code = useCode();
  const counts = useOptionalComments()?.counts;
  const { state, project, projectId, applySession } = useProject();
  useBrowserTabsRevision(projectId);
  useTerminalTabsRevision(projectId);
  usePlanTabsRevision(projectId);
  const { bridge, projects } = useApp();
  const activity = useActivity();
  // Remote access: on a paired device the commands and project settings are the computer's; sends need the permission.
  const device = useHost().remoteDevice;
  const commandsApi = useCommandsApi();
  const api = mayChangeProject(device) ? commandsApi : null;
  const store = useRunsStore();
  const busyKey = useRunsSelector((s) =>
    runningRuns(s)
      .map((r) => r.name.toLowerCase())
      .join("\n"),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [start, setStart] = useState<HTMLElement | null>(null);
  const [end, setEnd] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ start, end }), [start, end]);
  const ctx = {
    state,
    projectName: project?.name,
    orchestratorId: project?.orchestrator_agent_id,
    chatSessionId: ws.chatSessionId,
    file: code.file,
    comments: (key: FileKey) => counts?.get(key) ?? 0,
    runStatus: (name: string) => ws.runStatuses[name.toLowerCase()] ?? null,
    browser: (id: string) => {
      const b = getBrowserTabState(projectId, id);
      return { url: b.url, title: b.title, pins: getBrowserTabPins(projectId, id) };
    },
    terminal: (id: string) => getTerminalTabState(projectId, id),
    plan: (id: string) => getPlanTabState(projectId, id),
  };
  // The action runs once the sheet has given focus back to its opener (which would otherwise take the focus, and the dock's
  // shown group, back to the conversation).
  const closeAndRun = (fn: () => void) => {
    props.onClose();
    window.setTimeout(fn, 0);
  };
  const then = (fn: () => void) => () => closeAndRun(fn);
  const busy = new Set(busyKey ? busyKey.split("\n") : []);
  const commands = project ? menuOrder(project.commands ?? []) : [];
  const asyncHooks: PhoneMoreAsyncHooks = {
    setPending,
    setProblem,
    closeAndRun,
    isMounted: () => mounted.current,
  };
  const createSession = () => {
    if (pending !== null) return;
    void runPhoneMoreCreateSession(
      {
        projectId,
        createSession: (id) => bridge.createSession(id),
        applySession,
        refreshSessions: () => activity.refreshSessions(),
        showSession: (id) => ws.showSession(id),
      },
      asyncHooks,
    );
  };
  const run = (name: string) => {
    if (pending !== null) return;
    void runPhoneMoreCommand(
      {
        name,
        alreadyRunning: busy.has(name.toLowerCase()),
        startRun: api ? () => startProjectRun(api, store, name) : null,
        openRun: (n) => ws.openRun(n),
      },
      asyncHooks,
    );
  };
  // A4: the panel's purpose (the desktop's (i) after its title) leads the sheet on the phone.
  const ref = parseTab(props.active);
  const purpose = ref?.kind === "tool" ? TOOL_PURPOSE[ref.tool] : null;
  const others = (projects ?? []).filter((p) => p.status === "running" && p.id !== projectId).length;
  const working = workingText(others);
  return (
    <Sheet label="More" onClose={props.onClose}>
      <div data-phone-more className="flex flex-col pb-2">
        {problem && (
          <div className="px-4 pb-2">
            <Notice tone="error">{problem}</Notice>
          </div>
        )}
        {purpose && (
          <Group title="About this panel">
            <p data-phone-purpose className="px-2 pb-2 text-sm text-fg-2">
              {purpose}
            </p>
          </Group>
        )}
        <Group title="This session">
          {props.tabs.map((t) => {
            const info = tabInfo(t, ctx);
            return (
              <ListRow
                key={t}
                size="lg"
                selected={t === props.active}
                leading={info.glyph && info.glyph !== "idle" ? <StateGlyph state={info.glyph} size={14} box={16} /> : <Glyph icon={info.icon} size={16} />}
                title={withoutProject(info.name ?? info.label, project?.name)}
                onClick={then(() => ws.activate(t))}
              />
            );
          })}
          {deviceMay(device, "send") && (
            <ListRow
              size="lg"
              disabled={pending !== null}
              leading={pending === "new-session" ? <Spinner /> : <Glyph icon={Plus} size={16} />}
              title="New session"
              description={pending === "new-session" ? "Creating session…" : undefined}
              onClick={createSession}
            />
          )}
        </Group>
        {api && (
          <Group title="Run">
            {commands.map((c) => {
              const key = c.name.toLowerCase();
              const isRunning = busy.has(key);
              const isStarting = pending === `run:${key}`;
              return (
                <ListRow
                  key={c.name}
                  size="lg"
                  disabled={pending !== null}
                  leading={isRunning || isStarting ? <Spinner /> : <Glyph icon={Play} size={16} />}
                  title={c.name}
                  description={isRunning ? "Running: show it" : isStarting ? "Starting…" : c.command}
                  onClick={() => run(c.name)}
                />
              );
            })}
            <ListRow
              size="lg"
              leading={<Glyph icon={SlidersHorizontal} size={16} />}
              title={commands.length > 0 ? "Edit commands" : "Add commands"}
              onClick={then(() => window.location.assign(settingsHref("commands")))}
            />
          </Group>
        )}
        {(() => {
          const enabledPanels = PANELS.filter((tool) => ws.toolEnabled(tool));
          return (
            enabledPanels.length > 0 && (
              <Group title="Panels">
                <div className="grid grid-cols-2 gap-1">
                  {enabledPanels.map((tool) => {
                    const t = TOOL_TABS[tool];
                    return (
                      <ListRow
                        key={tool}
                        size="lg"
                        selected={props.active === toolTab(tool)}
                        leading={<Glyph icon={t.icon} size={16} />}
                        title={t.label}
                        onClick={then(() => ws.openTool(tool))}
                      />
                    );
                  })}
                </div>
              </Group>
            )
          );
        })()}
        <StatusSlotsContext.Provider value={slots}>
          <Group title="Status">
            <div data-phone-status className="flex flex-col">
              <div ref={setStart} className="contents" />
              <div ref={setEnd} className="contents" />
              {working && (
                <ListRow size="lg" leading={<StateGlyph state="working" size={14} box={16} />} title={working} onClick={then(() => navigate(null))} />
              )}
              <RemoteIndicator />
            </div>
            <ProjectStatus />
          </Group>
        </StatusSlotsContext.Provider>
        <Group title="Settings">
          {mayChangeProject(device) ? (
            <ListRow size="lg" leading={<Glyph icon={SlidersHorizontal} size={16} />} title="Project settings" onClick={then(() => ws.openSettings())} />
          ) : (
            <ListRow size="lg" leading={<Glyph icon={SlidersHorizontal} size={16} />} title="Project settings" description={ON_YOUR_COMPUTER} disabled />
          )}
          <ListRow size="lg" leading={<Glyph icon={Settings} size={16} />} title="Settings" onClick={then(() => window.location.assign(settingsHref("")))} />
        </Group>
      </div>
    </Sheet>
  );
}

/** A9.3: the header says the project; a conversation's row says its session ("Project / topic" → "topic"). */
function withoutProject(name: string, projectName: string | undefined): string {
  return projectName && name.startsWith(`${projectName} / `) ? name.slice(projectName.length + 3) : name;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col px-2 pt-2">
      <h3 className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">{title}</h3>
      {children}
    </section>
  );
}
