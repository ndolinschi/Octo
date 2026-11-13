import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { CARRIED, NOT_CARRIED } from "../../lib/sessions/carry";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";

/**
 * "New session" with a short confirmation in plain words: what the new session starts from and what it leaves behind, and
 * a link to Memory ("What it remembers"). The session is made only by the button inside it.
 */
export function NewSessionButton(props: { loading: boolean; onCreate(): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const ws = useOptionalWorkspace();
  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        size="sm"
        icon={Plus}
        loading={props.loading}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        New session
      </Button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Popover anchor={anchor} label="New session" onClose={() => setOpen(false)} className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-3 p-3 text-sm">
            <p className="text-fg-2">
              <span className="text-fg">Carried over: </span>
              {CARRIED}
            </p>
            <p className="text-fg-2">
              <span className="text-fg">Not carried over: </span>
              {NOT_CARRIED}
            </p>
            <div className="flex items-center gap-2">
              {ws && (
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
                  props.onCreate();
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
