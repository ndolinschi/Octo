import { Check, ChevronDown, Circle, Minus, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { PullRequestRow, ReviewFile } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { CHECKS_LABEL } from "../../lib/review/pull";
import { formatBytes } from "../../lib/review/files";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Glyph } from "../primitives/Glyph";
import { Menu, type MenuItem } from "../primitives/Menu";
import { MiddleText } from "../primitives/MiddleText";
import { Presence } from "../primitives/Presence";

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

/** "owner/name" gives way from the owner ("atl…/atlas-api"); any other text from its middle. */
function CutText({ text, className, siblings }: { text: string; className: string; siblings?: readonly string[] | undefined }) {
  const slash = text.lastIndexOf("/");
  if (slash <= 0) return <MiddleText text={text} {...(siblings ? { siblings } : {})} {...(className ? { className } : {})} />;
  return (
    <span className={cn("flex min-w-0 items-baseline", className)}>
      <span className="min-w-0 truncate">{text.slice(0, slash)}</span>
      <span className="shrink-0">{text.slice(slash)}</span>
    </span>
  );
}

/**
 * Polish step 6b (R1, R3): a quiet 28px menu trigger whose text gives way from its middle ("atlas-l…/atlas-api"), so a
 * header line keeps its one line in a narrow group. `MenuButton` is 24px and never truncates; this composes `Button` and
 * `Menu` for the review's headers only.
 */
export function TextMenu(props: {
  label: string;
  text: string;
  items: MenuItem[];
  mono?: boolean;
  alignEnd?: boolean;
  /** The other choices: a name sharing a long head with them keeps the part that tells it apart. */
  siblings?: readonly string[];
  className?: string;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={button}
        variant="quiet"
        size="sm"
        title={props.text}
        aria-label={`${props.label}: ${props.text}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: props.alignEnd ? r.right : r.left, y: r.bottom + 4 });
        }}
        className={cn("min-w-0 shrink! gap-1!", menu && "bg-active text-fg", props.className)}
      >
        <CutText text={props.text} siblings={props.siblings} className={props.mono ? "font-mono text-xs" : ""} />
        <Glyph icon={ChevronDown} size={14} className="shrink-0 text-fg-3" />
      </Button>
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label={props.label} x={menu.x} y={menu.y} alignEnd={props.alignEnd ?? false} items={props.items} onClose={() => setMenu(null)} />}
      </Presence>
    </>
  );
}

export function Key({ children }: { children: ReactNode }) {
  return (
    <kbd aria-hidden data-key-hint className="octo-v7-kbd max-sm:hidden">
      {children}
    </kbd>
  );
}
