import type { Folder } from "@octo/agent-client";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Presence } from "../primitives/Presence";
import { ModelPicker } from "../shared/ModelPicker";

/** The folder menu opens on a click: its own chunk (shared with every other menu), warmed after the first paint. */
const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));

/** The folder picker loads when first opened (decision 49; its own chunk). */
const FolderPicker = lazy(() => import("../shared/FolderPicker").then((m) => ({ default: m.FolderPicker })));

/** Gap between a chip and the menu it opens (decision 56). */
const MENU_GAP = 4;

export type ChipProps = { bare: boolean; disabled: boolean; onOpenChange(open: boolean): void };

export function useChipMenu(onOpenChange: (open: boolean) => void) {
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
export function ModelChip(
  props: ChipProps & {
    footer?: ReactNode;
    openRequest?: { n: number; query: string } | undefined;
    value: string;
    title?: string | undefined;
    unavailable?: boolean;
    short?: boolean;
    onChoose(value: string): void;
    onChooseUnverified?: (value: string) => void;
  },
) {
  return (
    <ModelPicker
      label="Model"
      value={props.value}
      onChoose={props.onChoose}
      onChooseUnverified={props.onChooseUnverified}
      bare={props.bare}
      {...(props.short ? { short: true } : {})}
      disabled={props.disabled}
      side="top"
      warn={props.unavailable === true}
      tip={props.unavailable ? "This model's provider is not connected" : props.title}
      footer={props.footer}
      openRequest={props.openRequest}
      onOpenChange={props.onOpenChange}
    />
  );
}

/** The label of the folders entry in the "+" menu: the first one's name (+N). */
export function foldersLabel(folders: readonly Folder[]): string {
  const [first] = folders;
  return first ? (folders.length > 1 ? `${first.label} +${folders.length - 1}` : first.label) : "No folder";
}

/**
 * The folders the orchestrator works in, opened from the "+" menu's "Folders" entry (it was a chip of the control row): the menu
 * lists them, adds one with the folder picker (decision 49) and leads to settings. It closes itself through `onClose`.
 */
export function FolderMenu(props: {
  anchor: RefObject<HTMLElement | null>;
  folders: Folder[];
  onAdd?: ((path: string) => void) | undefined;
  onClose(): void;
  onOpenChange(open: boolean): void;
}) {
  const [menuOpen, setMenuOpen] = useState(true);
  const [picking, setPicking] = useState(false);
  const ws = useOptionalWorkspace();
  const { onClose, onOpenChange } = props;
  const add = props.onAdd;
  useEffect(() => {
    if (!menuOpen && !picking) onClose();
  }, [menuOpen, picking, onClose]);
  const r = props.anchor.current?.getBoundingClientRect();
  const pos = r ? { x: r.left, y: r.top - MENU_GAP } : { x: 0, y: 0 };
  return (
    <>
      <Presence show={menuOpen} exitMs={0}>
        {menuOpen && (
          <Suspense fallback={null}>
            <Menu
              label="Folders"
              x={pos.x}
              y={pos.y}
              above
              onClose={() => setMenuOpen(false)}
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
          </Suspense>
        )}
      </Presence>
      <Presence show={picking}>
        {picking && add && (
          <Suspense fallback={null}>
            <FolderPicker
              anchor={props.anchor}
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
