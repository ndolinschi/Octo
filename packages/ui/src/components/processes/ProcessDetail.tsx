import { Check, Copy, Globe, OctagonX, RotateCw, Square } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { durationText, stripAnsi } from "../../lib/commands/format";
import { extractLocalUrls } from "../../lib/commands/urls";
import { useNow } from "../../lib/hooks";
import { useCopy } from "../../lib/hooksMore";
import { DETAIL_COLUMN } from "../../lib/panelColumn";
import {
  canRestartProcess,
  isProcessActive,
  processCommand,
  processCwd,
  processKindLabel,
  processName,
  processPid,
  processStartedAt,
  processStatusText,
  processTone,
  type ProcessItem,
} from "../../lib/processes/model";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { IconButton } from "../primitives/IconButton";
import { DetailHeader } from "../primitives/Panel";

const TONE_CLASS = {
  run: "text-fg-2",
  ok: "text-ok",
  err: "text-err",
  muted: "text-fg-3",
} as const;

const FOLLOW_SLACK_PX = 24;

/**
 * Detail view of a chosen command run or background worker: header with Open in Browser, Restart, Stop and Kill (`SIGKILL`),
 * exact command line, working directory, PID/timing facts, and auto-following output / stderr tail.
 */
export function ProcessDetail(props: { item: ProcessItem; busy: string | null; canManage: boolean; onStop(): void; onKill(): void; onRestart(): void }) {
  const { item, busy, canManage } = props;
  const ws = useOptionalWorkspace();
  const [copied, copy] = useCopy();
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  const name = processName(item);
  const command = processCommand(item);
  const pid = processPid(item);
  const cwd = processCwd(item);
  const startedAt = processStartedAt(item);
  const active = isProcessActive(item);
  const restartable = canRestartProcess(item);
  const rawOutput = item.kind === "command" ? item.output : (item.worker.output ?? "");
  const text = stripAnsi(rawOutput);
  const localUrl = item.kind === "command" ? extractLocalUrls(rawOutput)[0] : undefined;

  useLayoutEffect(() => {
    following.current = true;
  }, [item.key]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [text, item.key]);

  const tone = processTone(item);
  const statusWords = processStatusText(item);
  const ticking = item.kind === "command" ? item.run.status === "running" : item.worker.status === "running" || item.worker.status === "busy";
  const notes = item.kind === "command" ? [item.run.truncated && "Output cut at 5 MB", item.clipped && "Earlier output not shown"].filter(Boolean) : [];

  return (
    <article data-process-detail={item.key} aria-label={name} className={cn("flex flex-col gap-3", DETAIL_COLUMN)}>
      <DetailHeader
        title={name}
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <span className={cn("font-medium", TONE_CLASS[tone])}>{statusWords}</span>
            <span>·</span>
            <span>{processKindLabel(item)}</span>
            {pid !== undefined && (
              <>
                <span>·</span>
                <span data-process-pid={pid} className="font-mono tabular-nums">
                  PID {pid}
                </span>
              </>
            )}
            {ticking && startedAt ? (
              <>
                <span>·</span>
                <LiveDuration startedAt={startedAt} />
              </>
            ) : item.kind === "command" && item.run.duration_ms > 0 ? (
              <>
                <span>·</span>
                <span className="tabular-nums">{durationText(item.run.duration_ms)}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {canManage && restartable && (
              <Button variant="secondary" size="sm" icon={RotateCw} data-process-restart disabled={busy !== null} onClick={props.onRestart}>
                Restart
              </Button>
            )}
            {canManage && active && item.kind === "command" && (
              <Button
                variant="quiet"
                size="sm"
                icon={Square}
                data-process-stop
                disabled={busy !== null}
                title="Gracefully stop this process (SIGTERM)"
                onClick={props.onStop}
              >
                Stop
              </Button>
            )}
            {canManage && active && (
              <Button
                variant="danger"
                size="sm"
                icon={OctagonX}
                data-process-kill
                disabled={busy !== null}
                title="Force-kill this process immediately (SIGKILL)"
                onClick={props.onKill}
              >
                Kill
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-3 px-2">
        <CommandLine command={command} label="command" />

        {localUrl && ws && (
          <div className="flex min-h-ctl-sm items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-fg-2" title={localUrl}>
              {localUrl}
            </span>
            <Button variant="secondary" size="sm" icon={Globe} onClick={() => ws.openBrowser({ url: localUrl })}>
              Open in Browser
            </Button>
          </div>
        )}

        {cwd && (
          <p className="truncate font-mono text-xs text-fg-3" title={cwd}>
            Folder: {cwd}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex min-h-ctl-sm items-center justify-between gap-2">
            <span className="text-xs text-fg-3">
              {item.kind === "command" ? "Process output" : "Worker stderr tail"}
              {notes.length > 0 && ` · ${notes.join(" · ")}`}
            </span>
            {text.length > 0 && (
              <IconButton icon={copied ? Check : Copy} size="sm" label={copied ? "Copied output" : "Copy output"} onClick={() => copy(text)} />
            )}
          </div>
          <pre
            ref={box}
            data-process-output
            aria-label={`Output of ${name}`}
            onScroll={(e) => {
              const el = e.currentTarget;
              following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
            }}
            className="max-h-[58vh] min-h-32 overflow-y-auto overscroll-contain rounded-md bg-code-bg p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg focus-inset"
          >
            {text || (item.kind === "command" ? (active ? "Waiting for output…" : "No output.") : "No diagnostic output on stderr.")}
          </pre>
        </div>
      </div>
    </article>
  );
}

function LiveDuration({ startedAt }: { startedAt: string }) {
  const now = useNow(true, 1000);
  return <span className="tabular-nums">{durationText(Math.max(0, now - Date.parse(startedAt)))}</span>;
}
