import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { CommandLine } from "./CommandLine";
import { Glyph } from "./Glyph";

type Tone = "info" | "warn" | "error" | "success";

const TONE: Record<Tone, { icon: LucideIcon; text: string; glyph: string }> = {
  info: { icon: Info, text: "text-fg-2", glyph: "text-fg-3" },
  warn: { icon: TriangleAlert, text: "text-warn", glyph: "text-warn" },
  error: { icon: CircleAlert, text: "text-err", glyph: "text-err" },
  success: { icon: CircleCheck, text: "text-ok", glyph: "text-ok" },
};

/**
 * A message about what just happened or what is wrong (decision 90; replaces the five Notice / Banner / ErrorLine
 * look-alikes and the 19 hand-written `text-xs text-err` lines). Tone is carried by the glyph and the text colour only:
 * no coloured border, fill or pulse (decision 81). The role is set here: `alert` for `error`, `status` otherwise.
 * Every error says what to do next (rule 20): put it in `children` or give an `action`.
 *
 * - `tone`: `info`, `warn`, `error`, `success`.
 * - `form="line"` (default): one inline line, 12px text, glyph in front, optional `action` (a `Button variant="link"` or
 *   quiet) at the end; wraps when narrow. For field messages, save status, a bar under a header.
 * - `form="block"`: a neutral `raised` block, no outline (polish step 3, C3: a block is a tone), with a `title`, the text, `actions` under it and an optional `command` copy line.
 *
 * Not for: an empty or centred state (`EmptyState`), a toast, a tooltip, the validation message of one field (`Field error`).
 */
export function Notice(props: {
  tone?: Tone;
  form?: "line" | "block";
  title?: string;
  children?: ReactNode;
  /** `line`: one control at the end of the line. */
  action?: ReactNode;
  /** `block`: buttons under the text. */
  actions?: ReactNode;
  /** `block`: a command to run, in the copy line. */
  command?: string;
  className?: string;
}) {
  const tone = TONE[props.tone ?? "info"];
  const role = props.tone === "error" ? "alert" : "status";
  if (props.form === "block") {
    return (
      <div role={role} className={cn("octo-in-card flex min-w-0 flex-col gap-2 rounded-md bg-raised p-card text-sm", props.className)}>
        <div className="flex min-w-0 items-start gap-2">
          <Glyph icon={tone.icon} size={16} className={cn("mt-0.5 shrink-0", tone.glyph)} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {props.title && <p className={cn("text-heading", tone.text)}>{props.title}</p>}
            {props.children && <div className="break-words text-fg-2">{props.children}</div>}
          </div>
        </div>
        {props.command && <CommandLine command={props.command} />}
        {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
      </div>
    );
  }
  return (
    <div role={role} className={cn("flex min-w-0 items-start gap-2 text-xs", tone.text, props.className)}>
      <span aria-hidden className="grid h-4 shrink-0 place-items-center">
        <Glyph icon={tone.icon} size={14} className={tone.glyph} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words">{props.children}</span>
        {props.action}
      </div>
    </div>
  );
}
