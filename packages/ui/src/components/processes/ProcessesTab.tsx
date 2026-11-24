import type { AdhocCommandInput, WorkerProcess } from "@octo/agent-client";
import { Check, OctagonX, Plus, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { durationText } from "../../lib/commands/format";
import { runsReducer } from "../../lib/commands/runs";
import { errorMessage } from "../../lib/format";
import { useHistoryLayer } from "../../lib/historyLayer";
import { useListStops } from "../../lib/listStops";
import { usePhone } from "../../lib/phone";
import {
  buildProcessList,
  canRestartProcess,
  commandKey,
  FILTERS,
  filterProcesses,
  isProcessActive,
  processCommand,
  processCounts,
  processGlyph,
  processName,
  processPid,
  processStarter,
  processStatusText,
  processTone,
  workerKey,
  type ProcessFilter,
  type ProcessItem,
} from "../../lib/processes/model";
import { useQuietOpen } from "../../lib/quietFocus";
import { mayChangeProject } from "../../lib/remoteDevice";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useProjectRunsState, useRunsStore } from "../../state/projectRuns";
import { Button } from "../primitives/Button";
import { FilterTabs, type Filter } from "../primitives/FilterTabs";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { IconMenu } from "../primitives/IconMenu";
import { ListDetail } from "../primitives/ListDetail";
import { ListRow } from "../primitives/ListRow";
import type { MenuItem } from "../primitives/Menu";
import { Notice } from "../primitives/Notice";
import { Panel, PanelEmpty, PanelFilters } from "../primitives/Panel";
import { Presence } from "../primitives/Presence";
import { SearchField } from "../primitives/SearchField";
import { StateGlyph } from "../primitives/StateGlyph";
import { PanelPurpose } from "../shared/PanelPurpose";
import { ProcessDetail } from "./ProcessDetail";
import { StartProcessDialog } from "./StartProcessDialog";

/**
 * The Processes tool tab (`tool:processes`): displays active and recent project command runs, ad-hoc shell processes,
 * language servers and agent CLI workers in one list-detail workspace, with live output, Stop (`SIGTERM`), Kill (`SIGKILL`),
 * Restart (spawning a fresh PID), Open in Browser, and "+ New process".
 */
export default function ProcessesTab() {
  const { bridge } = useApp();
  const { project, projectId, state: projectState } = useProject();
  const canManage = mayChangeProject(useHost().remoteDevice);
  const runsState = useProjectRunsState();
  const store = useRunsStore();

  const [workers, setWorkers] = useState<WorkerProcess[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProcessFilter>("all");
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  const listRef = useRef<HTMLUListElement>(null);
  useListStops(listRef);

  const refreshWorkers = useCallback(async () => {
    if (!bridge.listWorkerProcesses) return;
    try {
      const next = await bridge.listWorkerProcesses(projectId);
      setWorkers(next);
    } catch {
      // Older harness versions without /processes simply show command runs.
    }
  }, [bridge, projectId]);

  const agentCount = projectState.agentOrder.length;
  const sessionList = projectState.sessions.list;
  const sessionTitle = (id: string) => sessionList.find((s) => s.id === id)?.title;
  useEffect(() => {
    void refreshWorkers();
  }, [refreshWorkers, agentCount]);

  const allItems = useMemo(() => buildProcessList(runsState, workers), [runsState, workers]);
  const counts = useMemo(() => processCounts(allItems), [allItems]);
  const shown = useMemo(() => filterProcesses(allItems, filter, query), [allItems, filter, query]);

  const picked = selected !== null ? (allItems.find((i) => i.key === selected) ?? null) : null;
  const current = picked ?? shown[0] ?? null;

  useHistoryLayer(usePhone() && picked !== null, () => setSelected(null));

  // Hydrate tail output for a selected command run whose live stream was not observed in this window.
  const currentCmdId = current?.kind === "command" ? current.run.id : null;
  const needsTail = current?.kind === "command" && current.output === "" && current.run.output_bytes > 0;
  useEffect(() => {
    if (!bridge.getCommandRun || !currentCmdId || !needsTail) return;
    let alive = true;
    bridge.getCommandRun(projectId, currentCmdId).then(
      (run) => alive && store.update((s) => runsReducer(s, { type: "tail", run })),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, store, currentCmdId, needsTail]);

  const startAdhoc = async (input: AdhocCommandInput) => {
    setProblem(null);
    if (bridge.startCommandRun) {
      const r = await bridge.startCommandRun(projectId, input);
      store.update((s) => runsReducer(s, { type: "event", event: { type: "command.started", seq: 0, run: r.run } }));
      setSelected(commandKey(r.run.id));
      if (filter === "stopped") setFilter("all");
      return;
    }
    if (bridge.runCommand && input.name) {
      const r = await bridge.runCommand(projectId, input.name);
      store.update((s) => runsReducer(s, { type: "event", event: { type: "command.started", seq: 0, run: r.run } }));
      setSelected(commandKey(r.run.id));
      if (filter === "stopped") setFilter("all");
      return;
    }
    throw new Error("This local service does not support starting processes");
  };

  const stopItem = async (item: ProcessItem, force: boolean) => {
    setBusy(item.key);
    setProblem(null);
    try {
      if (item.kind === "command") {
        if (!bridge.stopCommandRun) return;
        const run = await bridge.stopCommandRun(projectId, item.run.id, force ? { force: true } : undefined);
        store.update((s) => runsReducer(s, { type: "tail", run }));
      } else {
        if (!bridge.stopWorkerProcess) return;
        await bridge.stopWorkerProcess(projectId, item.worker.id);
        await refreshWorkers();
      }
    } catch (e) {
      setProblem(`Could not ${force ? "kill" : "stop"} ${processName(item)}: ${errorMessage(e).replace(/\.$/, "")}.`);
    } finally {
      setBusy(null);
    }
  };

  const restartItem = async (item: ProcessItem) => {
    setBusy(item.key);
    setProblem(null);
    try {
      if (item.kind === "command") {
        if (bridge.restartCommandRun) {
          const started = await bridge.restartCommandRun(projectId, item.run.id);
          store.update((s) => runsReducer(s, { type: "event", event: { type: "command.started", seq: 0, run: started.run } }));
          setSelected(commandKey(started.run.id));
          if (filter === "stopped") setFilter("all");
        } else if (bridge.runCommand) {
          const started = await bridge.runCommand(projectId, item.run.name);
          store.update((s) => runsReducer(s, { type: "event", event: { type: "command.started", seq: 0, run: started.run } }));
          setSelected(commandKey(started.run.id));
          if (filter === "stopped") setFilter("all");
        }
      } else if (bridge.restartWorkerProcess) {
        const nextProc = await bridge.restartWorkerProcess(projectId, item.worker.id);
        if (nextProc) {
          setWorkers((prev) => prev.map((w) => (w.id === item.worker.id ? nextProc : w)));
          setSelected(workerKey(nextProc.id));
        } else {
          await refreshWorkers();
        }
      }
    } catch (e) {
      setProblem(`Could not restart ${processName(item)}: ${errorMessage(e).replace(/\.$/, "")}.`);
    } finally {
      setBusy(null);
    }
  };

  const filterOptions: Filter<ProcessFilter>[] = FILTERS.map((f) => ({
    id: f.id,
    label: f.label,
    title: f.title,
    ...(counts[f.id] > 0 ? { count: counts[f.id] } : {}),
  }));

  return (
    <div ref={quiet} data-processes className="flex h-full min-h-0 flex-1 flex-col">
      <Panel
        name="processes"
        title="Processes"
        className="flex-1"
        meta={counts.running > 0 ? `${counts.running} running` : undefined}
        lead={<PanelPurpose tool="processes" />}
        notice={problem ? <Notice tone="error">{problem}</Notice> : undefined}
        actions={
          <>
            <IconButton icon={RefreshCw} size="sm" label="Refresh processes" onClick={() => void refreshWorkers()} />
            {canManage && (
              <Button variant="quiet" size="sm" icon={Plus} data-new-process onClick={() => setStarting(true)}>
                New process
              </Button>
            )}
          </>
        }
      >
        {allItems.length === 0 ? (
          <PanelEmpty
            title="No processes running"
            actions={
              canManage ? (
                <Button variant="secondary" size="sm" icon={Plus} onClick={() => setStarting(true)}>
                  Start a process
                </Button>
              ) : undefined
            }
          >
            Dev servers, project commands, language servers and agent workers appear here with live output, Kill and Restart.
          </PanelEmpty>
        ) : (
          <ListDetail
            label="Processes"
            listLabel="Processes"
            listSemantics="own"
            placeholder="Choose a process to inspect its output."
            selected={picked?.key ?? null}
            onSelect={setSelected}
            listHeader={
              <PanelFilters>
                <FilterTabs<ProcessFilter> label="Filter processes" bare options={filterOptions} value={filter} onChange={(v) => setFilter(v)} />
                <SearchField
                  label="Filter by name, command or PID"
                  placeholder="Filter processes…"
                  size="sm"
                  value={query}
                  onChange={setQuery}
                  className="ml-auto max-w-56 min-w-28 flex-1"
                />
              </PanelFilters>
            }
            detail={
              current ? (
                <ProcessDetail
                  item={current}
                  busy={busy}
                  canManage={canManage}
                  onStop={() => void stopItem(current, false)}
                  onKill={() => void stopItem(current, true)}
                  onRestart={() => void restartItem(current)}
                />
              ) : null
            }
            list={(select) =>
              shown.length === 0 ? (
                <PanelEmpty>{query.trim() ? `No process matches "${query.trim()}".` : "No processes in this state."}</PanelEmpty>
              ) : (
                <ul ref={listRef} aria-label="Processes" className="flex flex-col gap-1.5">
                  {shown.map((item) => (
                    <li key={item.key}>
                      <ProcessRow
                        item={item}
                        starter={processStarter(item, sessionTitle)}
                        selected={current?.key === item.key}
                        canManage={canManage}
                        busy={busy === item.key}
                        onSelect={() => select(item.key)}
                        onStop={() => void stopItem(item, false)}
                        onKill={() => void stopItem(item, true)}
                        onRestart={() => void restartItem(item)}
                      />
                    </li>
                  ))}
                </ul>
              )
            }
          />
        )}
      </Panel>
      <Presence show={starting}>
        {starting && (
          <StartProcessDialog
            commands={project?.commands ?? []}
            defaultCwd={project?.folders[0]?.path ?? ""}
            onStart={startAdhoc}
            onClose={() => setStarting(false)}
          />
        )}
      </Presence>
    </div>
  );
}

function ProcessRow(props: {
  item: ProcessItem;
  starter: string | null;
  selected: boolean;
  canManage: boolean;
  busy: boolean;
  onSelect(): void;
  onStop(): void;
  onKill(): void;
  onRestart(): void;
}) {
  const { item, canManage, busy } = props;
  const phone = usePhone();
  const active = isProcessActive(item);
  const restartable = canRestartProcess(item);
  const tone = processTone(item);
  const pid = processPid(item);
  const name = processName(item);
  const cmd = processCommand(item);
  const canStop = canManage && active && item.kind === "command" && !busy;
  const canKill = canManage && active && !busy;
  const actionSize = phone ? "lg" : "xs";

  const menuItems: MenuItem[] = [];
  if (canManage && restartable) menuItems.push({ id: "restart", label: "Restart", run: props.onRestart });
  if (canManage && active && item.kind === "command") menuItems.push({ id: "stop", label: "Stop", run: props.onStop });
  if (canManage && active) menuItems.push({ id: "kill", label: "Kill", run: props.onKill });

  return (
    <ListRow
      size="md"
      selected={props.selected}
      // Revealed on hover and keyboard focus like every other list (ListRow; always on touch); on a phone always shown.
      trailingShown={phone}
      data-process-row={item.key}
      leading={
        tone === "ok" && item.kind === "command" ? (
          <span className="flex text-ok">
            <Glyph icon={Check} size={14} />
          </span>
        ) : (
          <StateGlyph state={processGlyph(item)} size={14} box={16} />
        )
      }
      title={name}
      meta={
        pid !== undefined ? (
          <span className="font-mono tabular-nums">PID {pid}</span>
        ) : item.kind === "command" && item.run.duration_ms > 0 ? (
          <span className="tabular-nums">{durationText(item.run.duration_ms)}</span>
        ) : (
          processStatusText(item)
        )
      }
      description={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0">{processStatusText(item)}</span>
          {/* G3: who started it, after the state ("Running · by you · pnpm dev"); a long session title gives way. */}
          {props.starter && (
            <>
              <span>·</span>
              <span className="max-w-1/2 min-w-0 shrink truncate">{props.starter}</span>
            </>
          )}
          <span>·</span>
          <span className="min-w-0 flex-1 truncate font-mono">{cmd}</span>
        </span>
      }
      onClick={props.onSelect}
      // Work-surface polish item 5: hidden actions overlay the row's end (ListRow), so the PID / duration column ends on one
      // edge; on a phone they show in a slot as wide as the widest set (two lg buttons), so the column lines up there too.
      trailing={
        <span className={cn("flex shrink-0 items-center justify-end gap-0.5", phone && "w-[calc(var(--spacing-ctl-lg)*2+2px)]")}>
          {canStop && <IconButton icon={Square} size={actionSize} label={`Stop ${name}`} onClick={props.onStop} />}
          {(!phone || !canStop) && canKill && <IconButton icon={OctagonX} size={actionSize} label={`Kill ${name}`} onClick={props.onKill} />}
          {menuItems.length > 0 && !busy && <IconMenu label={`Actions for ${name}`} size={actionSize} items={menuItems} />}
        </span>
      }
    />
  );
}
