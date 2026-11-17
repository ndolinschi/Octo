import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { CARRIED, NOT_CARRIED } from "../../lib/sessions/carry";
import { useApp } from "../../state/app";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { FieldRow } from "../primitives/FieldRow";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";
import { Select } from "../primitives/Select";

/**
 * "New session" with a short confirmation in plain words: target project (when multiple projects exist), what the new session
 * starts from and what it leaves behind, and a link to Memory ("What it remembers").
 */
export function NewSessionButton(props: { loading: boolean; projectId?: string; memoryBlocked?: boolean; onCreate(targetProjectId?: string): void }) {
  const { projects } = useApp();
  const [open, setOpen] = useState(false);
  const [targetProject, setTargetProject] = useState(props.projectId ?? projects?.[0]?.id ?? "");
  const anchor = useRef<HTMLButtonElement>(null);
  const ws = useOptionalWorkspace();
  return (
    <>
      <Button
        ref={anchor}
        // R2: quiet, as Notes' "New note": the label ends on the rows' text edge, no framed third right edge.
        variant="quiet"
        size="sm"
        icon={Plus}
        loading={props.loading}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setTargetProject(props.projectId ?? projects?.[0]?.id ?? "");
          setOpen((v) => !v);
        }}
      >
        New session
      </Button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Popover anchor={anchor} label="New session" onClose={() => setOpen(false)} className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-3 p-3 text-sm">
            {(projects?.length ?? 0) > 1 && (
              <FieldRow
                fields={[
                  {
                    id: "sessions-new-project",
                    label: "Project",
                    control: (
                      <Select
                        id="sessions-new-project"
                        label="Project"
                        size="sm"
                        className="w-full"
                        value={targetProject}
                        onChange={setTargetProject}
                        options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
                      />
                    ),
                  },
                ]}
              />
            )}
            <p className="text-fg-2">
              <span className="text-fg">Carried over: </span>
              {CARRIED}
            </p>
            <p className="text-fg-2">
              <span className="text-fg">Not carried over: </span>
              {NOT_CARRIED}
            </p>
            <div className="flex items-center gap-2">
              {ws?.toolEnabled("memory") && !props.memoryBlocked && (
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => {
                    setOpen(false);
                    ws.openTool("memory");
                  }}
                >
                  What it remembers
                </Button>
              )}
              <Button variant="quiet" size="sm" className="ml-auto" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  props.onCreate(targetProject || undefined);
                }}
              >
                Start
              </Button>
            </div>
          </Popover>
        )}
      </Presence>
    </>
  );
}
