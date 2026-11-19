import type { AccessMode } from "@octo/agent-client";
import { FilePen, ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import { ACCESS_DETAIL, ACCESS_LABEL, ACCESS_MODES } from "../../lib/access";
import { Chip } from "../primitives/Chip";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { useChipMenu, type ChipProps } from "./ComposerChips";

const ACCESS_ICON: Record<AccessMode, LucideIcon> = {
  supervised: ShieldCheck,
  accept_edits: FilePen,
  full: ShieldOff,
};

/**
 * Permissions mode chip in the composer control row (Ask first / Accept edits / Allow all).
 * Loaded lazily alongside ModeChip to keep the entry bundle within budget.
 */
export function AccessChip(props: ChipProps & { value: AccessMode; onChoose(next: AccessMode): void }) {
  const { ref, open, setOpen, at } = useChipMenu(props.onOpenChange);
  const pos = open ? at() : null;
  return (
    <>
      <Chip
        ref={ref}
        icon={ACCESS_ICON[props.value]}
        name="Permissions"
        label={ACCESS_LABEL[props.value]}
        tip={`Permissions: ${ACCESS_LABEL[props.value]} — ${ACCESS_DETAIL[props.value]}.`}
        bare={props.bare}
        open={open}
        warn={props.value === "full"}
        disabled={props.disabled}
        aria-haspopup="menu"
        data-chip="access"
        onClick={() => setOpen(!open)}
      />
      <Presence show={pos !== null}>
        {pos && (
          <Menu
            label="Permissions"
            x={pos.x}
            y={pos.y}
            above
            onClose={() => setOpen(false)}
            items={ACCESS_MODES.map((m) => ({
              id: m,
              label: ACCESS_LABEL[m],
              sub: ACCESS_DETAIL[m],
              checked: m === props.value,
              run: () => props.onChoose(m),
            }))}
          />
        )}
      </Presence>
    </>
  );
}
