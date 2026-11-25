import type { Folder } from "@octo/agent-client";
import { lazy, Suspense, useEffect, useState, type RefObject } from "react";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Presence } from "../primitives/Presence";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const FolderPicker = lazy(() => import("../shared/FolderPicker").then((m) => ({ default: m.FolderPicker })));

const MENU_GAP = 4;

/**
 * The folders the orchestrator works in, opened from the "+" menu's "Folders" entry: lists them,
 * adds one with the folder picker (decision 49) and leads to settings. Closes itself through `onClose`.
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
  const canOpenFiles = Boolean(ws?.toolEnabled("files"));
  return (
    <>
      <Presence show={menuOpen}>
        {menuOpen && (
          <Suspense fallback={null}>
            <Menu
              label="Folders"
              x={pos.x}
              y={pos.y}
              above
              onClose={() => setMenuOpen(false)}
              items={[
                ...props.folders.map((f) => ({ id: f.id, label: f.label, title: f.path, disabled: !canOpenFiles, run: () => ws?.openTool("files") })),
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
