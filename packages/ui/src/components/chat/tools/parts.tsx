import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { resolveFolder, type FilePosition } from "../../../lib/files";
import { useCopy } from "../../../lib/hooks";
import { locateInProject } from "../../../lib/toolsMore";
import { callTimes } from "../../../lib/toolView";
import type { ToolUse } from "../../../lib/transcript";
import { useOptionalCode } from "../../../state/code";
import { useHost } from "../../../state/host";
import { useProject } from "../../../state/project";
import { useOptionalWorkspace } from "../../../state/workspace/WorkspaceProvider";
import { requestChangesFocus } from "../../../lib/changesFocus";
import { Button } from "../../primitives/Button";

/*
 * retest3 G1 (toolpolish): the pieces every tool body shares. The row above a body is its header (the verb, the file or command,
 * +N −M); the body is one frame directly under the row's text edge — the code background, radius 8 (`rounded-md`), a 12px
 * inset, hairlines between its parts, never a filled band — and ends in one action line: a quiet lead on the left ("Exited 0 ·
 * 4s", "Show all") and the actions on the right ("Open diff", "Go to line 12", "Raw"). Raw opens under that line, in the frame.
 */

/** One radius and one inset for every tool body. */
const FRAME = "octo-code-surface min-w-0 overflow-hidden text-xs";
export const INSET = "px-3 py-2";

/** What "Raw" shows: the call as the agent sent it and the result as it came back. */
export type RawCall = { input: string; result: string | null };

/** A tool body: its content, then the action line (lead · actions · Raw), then the raw call when opened. */
export function BodyFrame(props: { kind: string; children?: ReactNode; lead?: ReactNode; actions?: ReactNode; raw: RawCall | null }) {
  const [raw, setRaw] = useState(false);
  const content = props.children !== undefined && props.children !== null && props.children !== false;
  return (
    <div data-tool-body={props.kind} className={FRAME}>
      {props.children}
      {/* R2: on touch the line is as tall as a touch target and its actions 8px apart, so "Copy command" / "Raw" and the code
          above (a diff's last line number, a table's Copy) never share a touch zone. */}
      <div className={cn("flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 px-3 py-1 text-fg-3 touch:min-h-11", content && "border-t border-line")}>
        {props.lead !== undefined && props.lead !== null && props.lead !== false && (
          <span className="flex min-w-0 items-center gap-1.5 tabular-nums">{props.lead}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-4 touch:gap-6">
          {props.actions}
          {props.raw && (
            <TextAction onClick={() => setRaw((r) => !r)} pressed={raw} title={raw ? "Hide raw input and result" : "Show raw input and result"}>
              Raw
            </TextAction>
          )}
        </span>
      </div>
      {raw && props.raw && (
        <div data-tool-raw className={cn("flex flex-col gap-2 border-t border-line", INSET)}>
          {props.raw.input && <RawBlock label="Input" text={props.raw.input} />}
          {props.raw.result !== null && <RawBlock label="Result" text={props.raw.result || "(empty)"} />}
          {!props.raw.input && props.raw.result === null && <span className="text-fg-3">Nothing was recorded for this call.</span>}
        </div>
      )}
    </div>
  );
}

/** A quiet text toggle ("Show content"): words only, no fill at rest; its text sits on the inset. */
export function Disclosure(props: { open: boolean; onToggle(): void; children: ReactNode; controls?: string }) {
  return (
    <Button
      variant="quiet"
      size="xs"
      aria-expanded={props.open}
      {...(props.controls ? { "aria-controls": props.controls } : {})}
      onClick={props.onToggle}
      className="-mx-2 text-fg-3"
    >
      {props.children}
    </Button>
  );
}

/** A quiet text action in a body's action line ("Open diff", "Go to line 12"); its text sits on the inset. */
export function TextAction(props: { onClick(): void; children: ReactNode; title?: string; label?: string; pressed?: boolean }) {
  return (
    <Button
      variant="quiet"
      size="xs"
      onClick={props.onClick}
      {...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {})}
      {...(props.title ? { title: props.title } : {})}
      {...(props.label ? { "aria-label": props.label } : {})}
      className={cn("-mx-2", props.pressed ? "text-fg" : "text-fg-3")}
    >
      {props.children}
    </Button>
  );
}

/** "Copy command" in an action line; "Copied" for a moment after. */
export function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopy();
  return <TextAction onClick={() => copy(text)}>{copied ? "Copied" : label}</TextAction>;
}

/** "+12 −3" in the diff tones (the only colour a change carries outside its tinted rows); a side that is 0 is left out. */
export function Counts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 text-xs tabular-nums", className)}>
      {(added > 0 || removed === 0) && <span className="text-ok">+{added}</span>}
      {removed > 0 && <span className="text-err">−{removed}</span>}
    </span>
  );
}

function RawBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-fg-3">{label}</span>
      <pre className="max-h-64 overflow-auto font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg-2">{text}</pre>
    </div>
  );
}

/** When the call started and its result was stored (the loaded transcripts; nothing when not loaded). */
export function useCallTimes(use: ToolUse): { start: string | null; end: string | null } {
  const { state } = useProject();
  return useMemo(() => callTimes(Object.values(state.messages), use.id), [state.messages, use.id]);
}

/**
 * Opens a project file at a line: an embedding host's `openFile` wins (it takes no line); otherwise the Files tab. `path` may be
 * folder-relative (built-in tools, with their `folder`) or absolute (ACP agents). Null when there is nowhere to open it.
 */
export function useOpenAt(): ((path: string, folder: string, at?: FilePosition) => void) | null {
  const { openFile } = useHost();
  const code = useOptionalCode();
  if (openFile) return (path, folder) => openFile(path, folder || undefined);
  if (!code) return null;
  return (path, folder, at) => {
    const hit = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? locateInProject(code.folders, path) : null;
    const target = hit ? hit.folder : resolveFolder(code.folders, folder || undefined);
    if (!target) return;
    code.openFile(target, hit ? hit.path : path.replace(/^\.\//, ""), at);
  };
}

/** The project-relative label of a path an ACP agent reported absolute ("atlas-api/src/x.ts"); the path itself otherwise. */
export function useShownPath(path: string, folder: string): string {
  const code = useOptionalCode();
  if (code && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
    const hit = locateInProject(code.folders, path);
    if (hit) return `${hit.folder}/${hit.path}`;
  }
  return folder && code && code.folders.length > 1 ? `${folder}/${path}` : path;
}

/**
 * Opens the Changes tab on a turn (and one of its files): the request goes through `lib/changesFocus`, which the Changes pane
 * reads. Null outside a workspace.
 */
export function useOpenChanges(): ((turnId: number, file?: { folder: string; path: string }) => void) | null {
  const ws = useOptionalWorkspace();
  if (!ws) return null;
  return (turnId, file) => {
    requestChangesFocus(file ? { turnId, folder: file.folder, path: file.path } : { turnId });
    ws.openTool("changes");
  };
}
