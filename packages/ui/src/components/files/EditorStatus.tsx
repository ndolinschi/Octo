import { CircleAlert, CircleX, Info } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooks";
import type { EditorIntel, Problem, ProblemSeverity } from "../../lsp/hub";
import { Button } from "../primitives/Button";
import { ListRow } from "../primitives/ListRow";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { type FileKey } from "../../lib/files";

const STATE_TEXT = { starting: "starting…", ready: "ready", failed: "failed", stopped: "stopped" } as const;

const ICON: Record<ProblemSeverity, { icon: typeof CircleX; className: string; label: string }> = {
  error: { icon: CircleX, className: "text-err", label: "Error" },
  warning: { icon: CircleAlert, className: "text-warn", label: "Warning" },
  info: { icon: Info, className: "text-fg-3", label: "Info" },
  hint: { icon: Info, className: "text-fg-3", label: "Hint" },
};

/**
 * The right side of a File tab's header when a language server serves the file: a problems count
 * (opens a compact list; a row jumps to its line) and the server's name and state. Quiet: muted
 * text, no state shown for the first 200ms of starting (no flash), Retry after a failure or exit.
 * `compact` (a narrow breadcrumb row) shows the server as a dot only, so it never competes with the crumbs.
 */
export function EditorStatus({
  intel,
  fileKey,
  onJump,
  compact = false,
}: {
  intel: EditorIntel;
  fileKey: FileKey;
  onJump(problem: Problem): void;
  /** Narrow row: the server as a state dot, its name in the tooltip. */ compact?: boolean;
}) {
  const info = useSyncExternalStore(intel.subscribe, () => intel.get(fileKey));
  const { status, problems, notice } = info;
  const starting = useDelayedLoading(status?.state === "starting");
  if (!status && !notice) return null;
  const shownState = status?.state === "starting" && !starting ? null : status?.state;
  const broken = status?.state === "failed" || status?.state === "stopped";

  return (
    <>
      {notice && (
        <span role="status" title={notice} className="min-w-0 truncate text-fg-3">
          {notice}
        </span>
      )}
      {problems.length > 0 && <ProblemsButton problems={problems} onJump={onJump} />}
      {status && (
        <span
          role="status"
          aria-label={`Language server: ${status.label}, ${STATE_TEXT[status.state]}`}
          title={status.error ? `${status.label}: ${status.error}` : `${status.label} (language server)`}
          className="flex min-w-0 shrink-0 items-center gap-1.5"
        >
          {shownState === "starting" && <Spinner size={10} />}
          {broken && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-err" />}
          {compact && shownState === "ready" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-fg-3" />}
          <span aria-hidden className={cn("max-w-[180px] truncate", compact && "hidden")}>
            {status.label}
            {shownState && shownState !== "ready" && <span className={cn(broken && "text-err")}> {STATE_TEXT[shownState]}</span>}
          </span>
        </span>
      )}
      {status && broken && (
        <Button variant="quiet" size="xs" onClick={() => intel.retry(fileKey)}>
          Retry
        </Button>
      )}
    </>
  );
}

function count(problems: Problem[], severity: ProblemSeverity): number {
  return problems.filter((p) => p.severity === severity).length;
}

function ProblemsButton({ problems, onJump }: { problems: Problem[]; onJump(problem: Problem): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const errors = count(problems, "error");
  const top = errors ? ICON.error : count(problems, "warning") ? ICON.warning : ICON.info;
  const Icon = top.icon;
  const n = problems.length;
  const sorted = [...problems].sort((a, b) => a.line - b.line || a.column - b.column);
  return (
    <>
      <Button
        ref={anchor}
        variant="quiet"
        size="xs"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((x) => !x)}
        className={cn("tabular-nums", open && "bg-active text-fg")}
      >
        <Glyph icon={Icon} size={14} className={top.className} />
        {n}&nbsp;{n === 1 ? "problem" : "problems"}
      </Button>
      <Presence show={open}>
        <Popover anchor={anchor} label="Problems in this file" align="end" onClose={() => setOpen(false)} className="w-[min(420px,calc(100vw-16px))]">
          <ul className="overflow-y-auto overscroll-contain p-1">
            {sorted.map((p, i) => {
              const s = ICON[p.severity];
              const PIcon = s.icon;
              return (
                <li key={i}>
                  <ListRow
                    size="md"
                    tip={p.message}
                    leading={<Glyph icon={PIcon} size={14} className={s.className} />}
                    title={
                      <>
                        <span className="sr-only">{s.label}: </span>
                        {p.message}
                      </>
                    }
                    description={`${p.source ? `${p.source} · ` : ""}Ln ${p.line}, Col ${p.column}`}
                    onClick={() => {
                      setOpen(false);
                      onJump(p);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Popover>
      </Presence>
    </>
  );
}
