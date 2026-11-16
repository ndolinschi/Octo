import { Circle, MoveUpRight, MousePointerClick, Pencil, Scan, Square, Undo2, type LucideIcon } from "lucide-react";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Switch } from "../primitives/Switch";

export type DesignTool = "select" | "area" | "draw" | "rect" | "ellipse" | "arrow";

const TOOLS: readonly { id: DesignTool; label: string; icon: LucideIcon }[] = [
  { id: "select", label: "Select element", icon: MousePointerClick },
  { id: "area", label: "Select area", icon: Scan },
  { id: "draw", label: "Freehand draw", icon: Pencil },
  { id: "rect", label: "Draw rectangle", icon: Square },
  { id: "ellipse", label: "Draw circle or ellipse", icon: Circle },
  { id: "arrow", label: "Draw arrow", icon: MoveUpRight },
];

/**
 * Contextual Design Mode bar shown directly beneath the Browser URL bar while annotating.
 * Exposes picker + markup tools, Undo, gesture hints, and the Batch edits switch.
 */
export function DesignHintBar(props: {
  tool: DesignTool;
  onToolChange(next: DesignTool): void;
  canUndo: boolean;
  onUndo(): void;
  batchEdits: boolean;
  onBatchEditsChange(next: boolean): void;
  onDone(): void;
}) {
  const batchSwitchId = "octo-design-batch-switch";
  const hint =
    props.tool === "select"
      ? `Click element · Shift+click multi · ↑/↓ parent/child · Double-click text · Alt+click to chat`
      : props.tool === "area"
        ? "Drag over an area · Shift locks square · Alt expands from centre"
        : `Drag to draw markup · Shift constrains · Alt from centre · ${MOD}Z undo`;

  return (
    <div
      data-design-hint-bar
      role="toolbar"
      aria-label="Design mode tools"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-raised px-2 py-1"
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {TOOLS.map((t) => (
          <IconButton
            key={t.id}
            icon={t.icon}
            label={t.label}
            size="xs"
            pressed={props.tool === t.id}
            data-design-tool={t.id}
            onClick={() => props.onToolChange(t.id)}
          />
        ))}
        <IconButton icon={Undo2} label={`Undo stroke (${MOD}Z)`} size="xs" disabled={!props.canUndo} onClick={props.onUndo} />
      </div>

      <span className="min-w-0 flex-1 truncate px-1 text-xs text-fg-3">{hint}</span>

      <div className="flex shrink-0 items-center gap-2">
        <label htmlFor={batchSwitchId} className="cursor-pointer text-xs text-fg-2 select-none">
          Batch edits
        </label>
        <Switch id={batchSwitchId} label="Batch edits" checked={props.batchEdits} onChange={props.onBatchEditsChange} />
        <Button variant="quiet" size="xs" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
