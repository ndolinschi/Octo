import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApprovalRuleSpec } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { patchCounts, patchLines } from "../../lib/v7/patch";
import { describeRule } from "../../lib/v7/rules";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";
import { LineCounts } from "./parts";

/** The change as a unified diff, folded behind "Show changes" (the card stays one decision, not a diff viewer). */
export function PatchView({ patch }: { patch: string }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => patchLines(patch), [patch]);
  const counts = useMemo(() => patchCounts(lines), [lines]);
  return (
    <div data-patch>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1.5 inline-flex h-6 press items-center gap-1 rounded-sm px-1.5 text-fg-2 hover:bg-hover hover:text-fg"
      >
        <Glyph icon={ChevronRight} size={14} className={cn("text-fg-3", open && "rotate-90")} />
        {open ? "Hide changes" : "Show changes"}
        <LineCounts added={counts.added} removed={counts.removed} className="ml-1" />
      </button>
      {open && (
        <pre
          aria-label="Changes"
          className="octo-code mt-1 max-h-60 overflow-auto rounded-sm bg-code-bg py-1 font-mono text-xs leading-5 focus-visible:shadow-[0_0_0_2px_var(--octo-focus)]"
        >
          {lines.map((l, i) => (
            <span
              key={i}
              data-line={l.kind}
              className={cn(
                "block min-w-max px-3 whitespace-pre",
                l.kind === "add" && "text-ok",
                l.kind === "del" && "text-err",
                (l.kind === "hunk" || l.kind === "meta") && "text-fg-3",
              )}
            >
              {l.text || " "}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

/**
 * Parity B4: the rule "Always allow" would save, shown exactly (kind, the code in mono, what it covers) before anything is
 * saved. Saving allows this request too. Nothing happens until "Save rule and allow".
 */
export function AlwaysPanel(props: { rule: ApprovalRuleSpec; busy: boolean; disabled: boolean; onSave(): void; onCancel(): void }) {
  const v = describeRule(props.rule);
  return (
    // Polish step 3, C3: inside the approval card the panel is the recessed tone, not an outline; its rule line is plain mono.
    <div data-always-panel role="group" aria-label="Always allow" className="flex flex-col gap-2 rounded-sm bg-panel px-3 py-2">
      <p className="text-fg-2">
        From now on, allow <span className="text-fg">{v.sentence}</span> in this project without asking:
      </p>
      <pre className="octo-code max-h-24 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
        <span className="font-sans text-fg-3 select-none">{v.subject}: </span>
        {v.code}
      </pre>
      <p className="text-xs text-fg-3">You can remove it later in the project's settings.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" className="max-md:h-10" disabled={props.disabled} aria-busy={props.busy} onClick={props.onSave}>
          {props.busy && <Spinner size={12} className="text-current" />}
          Save rule and allow
        </Button>
        <Button size="sm" variant="ghost" className="max-md:h-10" disabled={props.disabled} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
