import { Check, Circle, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { PullRequestRow, ReviewFile } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { CHECKS_LABEL } from "../../lib/review/pull";
import { formatBytes } from "../../lib/review/files";
import { EmptyState } from "../primitives/EmptyState";
import { Glyph } from "../primitives/Glyph";

/** `+12 −3` for a text file; a size for a binary one. */
export function LineStat({ file }: { file: Pick<ReviewFile, "added" | "removed" | "binary" | "new_size" | "old_size"> }) {
  if (file.binary) return <span className="shrink-0 text-xs text-fg-3">{formatBytes(file.new_size >= 0 ? file.new_size : file.old_size)}</span>;
  return <Counts added={file.added} removed={file.removed} />;
}

export function Counts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 text-xs tabular-nums", className)}>
      <span className="text-ok">+{added}</span>
      <span className="text-err">−{removed}</span>
    </span>
  );
}

const CHECK_ICON = { success: Check, failure: X, pending: Circle, none: Minus } as const;
const CHECK_TONE = { success: "text-ok", failure: "text-err", pending: "text-warn", none: "text-fg-3" } as const;

/** The state of the checks as a glyph with its words for assistive tech (and a tooltip). */
export function ChecksMark({ state, withLabel = false }: { state: PullRequestRow["checks"]; withLabel?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", CHECK_TONE[state])} title={CHECKS_LABEL[state]}>
      <Glyph icon={CHECK_ICON[state]} size={14} />
      {withLabel ? <span>{CHECKS_LABEL[state]}</span> : <span className="sr-only">{CHECKS_LABEL[state]}</span>}
    </span>
  );
}

/** A state a checks bucket from the API maps to; unknown buckets read as pending. */
export function checksState(s: string | undefined): PullRequestRow["checks"] {
  return s === "success" || s === "failure" || s === "pending" ? s : "none";
}

/** A centred message block (the shared `EmptyState`): empty, error and unavailable states of the review screens. */
export function Notice(props: { title: string; children?: ReactNode; actions?: ReactNode; tone?: "err" | "plain" }) {
  return (
    <EmptyState
      title={props.title}
      tone={props.tone ?? "plain"}
      actions={props.actions ? <div className="flex flex-wrap items-center justify-center gap-2">{props.actions}</div> : undefined}
    >
      {props.children}
    </EmptyState>
  );
}

/** A small "kbd" hint. */
export function Key({ children }: { children: ReactNode }) {
  return (
    <kbd aria-hidden className="octo-v7-kbd max-sm:hidden">
      {children}
    </kbd>
  );
}
