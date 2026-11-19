import type { ProjectMode } from "@octo/agent-client";
import { ListChecks, MessageCircleQuestionMark, Wrench, type LucideIcon } from "lucide-react";
import { MODE_DETAIL, MODE_LABEL } from "../../lib/modeLabels";
import { MODES } from "../../lib/modes";
import { Chip } from "../primitives/Chip";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import type { ChipProps } from "./ComposerChips";
import { useChipMenu } from "./chipMenu";

const MODE_ICON: Record<ProjectMode, LucideIcon> = { agent: Wrench, ask: MessageCircleQuestionMark, plan: ListChecks };

/**
 * Parity B3, decision 62: the mode of the next message (Agent / Ask / Plan) as one quiet chip. The menu picks the mode for
 * this message only and can make it the project's default; Shift+Tab in the text cycles it (the composer's key handler).
 * Its own chunk (the bundle budget): the composer shows a blank 28px square until it arrives.
 */
export function ModeChip(props: ChipProps & { value: ProjectMode; isDefault: boolean; onChoose(mode: ProjectMode): void; onMakeDefault(): void }) {
  const { ref, open, setOpen, at } = useChipMenu(props.onOpenChange);
  const pos = open ? at() : null;
  return (
    <>
      <Chip
        ref={ref}
        icon={MODE_ICON[props.value]}
        name="Mode"
        label={MODE_LABEL[props.value]}
        tip={`Mode: ${MODE_LABEL[props.value]}${props.isDefault ? "" : " (this message only)"}. Shift+Tab changes it.`}
        bare={props.bare}
        open={open}
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+Tab"
        data-chip="mode"
        onClick={() => setOpen(!open)}
      />
      <Presence show={pos !== null}>
        {pos && (
          <Menu
            label="Mode"
            x={pos.x}
            y={pos.y}
            above
            onClose={() => setOpen(false)}
            items={[
              ...MODES.map((m) => ({ id: m, label: MODE_LABEL[m], sub: MODE_DETAIL[m], checked: m === props.value, run: () => props.onChoose(m) })),
              { id: "sep", separator: true as const },
              { id: "default", label: `Make ${MODE_LABEL[props.value]} the project's default`, disabled: props.isDefault, run: props.onMakeDefault },
            ]}
          />
        )}
      </Presence>
    </>
  );
}
