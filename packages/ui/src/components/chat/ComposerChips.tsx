import type { Folder, TierPolicy } from "@octo/agent-client";
import { Layers } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { GLYPH } from "../primitives/glyphs";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { Chip } from "../primitives/Chip";
import { ModelPicker } from "../shared/ModelPicker";

/** The folder picker loads when first opened (decision 49; its own chunk). */
const FolderPicker = lazy(() => import("../shared/FolderPicker").then((m) => ({ default: m.FolderPicker })));

/** Gap between a chip and the menu it opens (decision 56). */
const MENU_GAP = 4;

/**
 * How many chips have shed their label (decision 62: tier first, then folder, then model) so the control row fits.
 * Measured: on a width change all labels come back and drop again until the row stops overflowing.
 */
export function useShedLabels(row: RefObject<HTMLElement | null>, max: number, key: string): number {
  const [level, setLevel] = useState(0);
  useLayoutEffect(() => {
    const el = row.current;
    if (el && level < max && el.scrollWidth > el.clientWidth + 0.5) setLevel(level + 1);
  }, [level, max, key, row]);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      const grew = el.clientWidth > width;
      width = el.clientWidth;
      // Wider: try every label again; narrower: the overflow check above sheds more.
      setLevel((l) => (grew ? 0 : l));
      if (!grew && el.scrollWidth > el.clientWidth + 0.5) setLevel((l) => Math.min(max, l + 1));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [row, max]);
  return level;
}

type ChipProps = { bare: boolean; disabled: boolean; onOpenChange(open: boolean): void };

function useChipMenu(onOpenChange: (open: boolean) => void) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
  };
  const at = () => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top - MENU_GAP } : { x: 0, y: 0 };
  };
  return { ref, open, setOpen, at };
}

/** The project's model or agent (decision 58): the shared model control, the same one the title bar shows. */
export function ModelChip(props: ChipProps & { value: string; title?: string | undefined; unavailable?: boolean; onChoose(value: string): void }) {
  return (
    <ModelPicker
      label="Model"
      value={props.value}
      onChoose={props.onChoose}
      bare={props.bare}
      disabled={props.disabled}
      side="top"
      warn={props.unavailable === true}
      tip={props.unavailable ? "This model's provider is not connected" : props.title}
      onOpenChange={props.onOpenChange}
    />
  );
}

/**
 * The folders the orchestrator works in: the first one's name (+N). The menu lists them, adds one with the folder
 * picker (decision 49) and leads to settings.
 */
export function FolderChip(props: ChipProps & { folders: Folder[]; onAdd?: ((path: string) => void) | undefined }) {
  const { ref, open, setOpen, at } = useChipMenu(props.onOpenChange);
  const [picking, setPicking] = useState(false);
  const ws = useOptionalWorkspace();
  const onOpenChange = props.onOpenChange;
  const add = props.onAdd;
  const [first] = props.folders;
  const label = first ? (props.folders.length > 1 ? `${first.label} +${props.folders.length - 1}` : first.label) : "No folder";
  const pos = open ? at() : null;
  return (
    <>
      <Chip
        ref={ref}
        icon={GLYPH.files}
        name="Folders"
        label={label}
        bare={props.bare}
        open={open}
        warn={!first}
        disabled={props.disabled}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="max-w-48"
      />
      <Presence show={pos !== null} exitMs={0}>
        {pos && (
          <Menu
            label="Folders"
            x={pos.x}
            y={pos.y}
            above
            onClose={() => setOpen(false)}
            items={[
              ...props.folders.map((f) => ({ id: f.id, label: f.label, title: f.path, run: () => ws?.openTool("files") })),
              ...(props.folders.length ? [{ id: "sep", separator: true as const }] : []),
              ...(add
                ? [
                    {
                      id: "add",
                      label: "Add a folder…",
                      run: () => {
                        setPicking(true);
                        onOpenChange(true);
                      },
                    },
                  ]
                : []),
              { id: "manage", label: "Project settings…", disabled: !ws, run: () => ws?.openSettings() },
            ]}
          />
        )}
      </Presence>
      <Presence show={picking}>
        {picking && add && (
          <Suspense fallback={null}>
            <FolderPicker
              anchor={ref}
              label="Add a folder"
              side="top"
              current={props.folders.map((f) => f.path)}
              onChoose={add}
              onClose={() => {
                setPicking(false);
                onOpenChange(false);
              }}
            />
          </Suspense>
        )}
      </Presence>
    </>
  );
}

const POLICY: Record<TierPolicy, { label: string; title: string }> = {
  auto: { label: "Auto", title: "Auto: the router may pick a lower or higher tier" },
  ceiling: { label: "Ceiling", title: "Ceiling: never above the requested tier" },
  fixed: { label: "Fixed", title: "Fixed: always the requested tier" },
};

const POLICIES: readonly TierPolicy[] = ["auto", "ceiling", "fixed"];

/** The router's tier policy (shown only when a router is in the path). */
export function TierChip(props: ChipProps & { value: TierPolicy; onChoose(value: TierPolicy): void }) {
  const { ref, open, setOpen, at } = useChipMenu(props.onOpenChange);
  const pos = open ? at() : null;
  return (
    <>
      <Chip
        ref={ref}
        icon={Layers}
        name="Routing"
        label={POLICY[props.value].label}
        bare={props.bare}
        open={open}
        disabled={props.disabled}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      />
      <Presence show={pos !== null} exitMs={0}>
        {pos && (
          <Menu
            label="Routing"
            x={pos.x}
            y={pos.y}
            above
            onClose={() => setOpen(false)}
            items={POLICIES.map((p) => ({ id: p, label: POLICY[p].label, title: POLICY[p].title, checked: p === props.value, run: () => props.onChoose(p) }))}
          />
        )}
      </Presence>
    </>
  );
}
