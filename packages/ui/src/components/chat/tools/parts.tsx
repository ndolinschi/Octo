import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
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
import { IconButton } from "../../primitives/IconButton";

/*
 * retest3 G1: the pieces every tool body shares — one frame (the code background, one radius, one inset), a quiet
 * disclosure, a copy button, the "Raw" view and the way a body opens a file at a line.
 */

/** One radius and one inset for every tool body. */
export const FRAME = "min-w-0 overflow-hidden rounded-md bg-code-bg text-xs";
export const INSET = "px-3 py-2";

/** A quiet text toggle ("Show all 64 lines", "Raw"): chevron + words, no fill at rest. */
export function Disclosure(props: { open: boolean; onToggle(): void; children: ReactNode; className?: string; controls?: string }) {
  return (
    <Button
      variant="quiet"
      size="xs"
      icon={props.open ? ChevronDown : ChevronRight}
      aria-expanded={props.open}
      {...(props.controls ? { "aria-controls": props.controls } : {})}
      onClick={props.onToggle}
      className={cn("-ml-1 text-fg-3", props.className)}
    >
      {props.children}
    </Button>
  );
}

/** A quiet text action in a body's footer row ("Open diff", "Go to line 12"). */
export function TextAction(props: { onClick(): void; children: ReactNode; title?: string; label?: string }) {
  return (
    <Button
      variant="quiet"
      size="xs"
      onClick={props.onClick}
      {...(props.title ? { title: props.title } : {})}
      {...(props.label ? { "aria-label": props.label } : {})}
      className="-mx-1 text-fg-3"
    >
      {props.children}
    </Button>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopy();
  return <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : label} size="xs" className="shrink-0" onClick={() => copy(text)} />;
}

/** "+12 −3" in the diff tones. */
export function Counts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 text-xs tabular-nums", className)}>
      <span className="text-ok">+{added}</span>
      <span className="text-err">−{removed}</span>
    </span>
  );
}

/** The call as the agent sent it and the result as it came back, for people who want them (never the default view). */
export function Raw({ input, result }: { input: string; result: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-tool-raw>
      <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
        Raw
      </Disclosure>
      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {input && <RawBlock label="Input" text={input} />}
          {result !== null && <RawBlock label="Result" text={result || "(empty)"} />}
        </div>
      )}
    </div>
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
