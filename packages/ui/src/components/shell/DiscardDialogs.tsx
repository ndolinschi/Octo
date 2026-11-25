import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Presence } from "../primitives/Presence";

// Both only open on unsaved edits; apart from the app shell so `Dialog` and its focus handling load after first paint.

export function LeaveDialog(props: { count: number; onStay(): void; onLeave(): void }) {
  const files = props.count === 1 ? "1\u00a0file has" : `${props.count}\u00a0files have`;
  return (
    <Dialog
      width="sm"
      title="Discard unsaved changes?"
      description={`${files} unsaved edits in this project. Leaving the project discards them.`}
      onClose={props.onStay}
      footer={
        <>
          <Button onClick={props.onStay} data-autofocus>
            Stay
          </Button>
          <Button variant="danger" onClick={props.onLeave}>
            Discard and leave
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

/** Closing tabs with unsaved edits asks first. */
export function CloseDialog() {
  const ws = useWorkspace();
  const closing = ws.closing;
  const many = (closing?.files.length ?? 0) > 1;
  return (
    <Presence show={closing !== null}>
      {closing && (
        <Dialog
          width="sm"
          title={many ? `Discard changes to ${closing.files.length}\u00a0files?` : `Discard changes to ${closing.files[0] ?? "this file"}?`}
          description={many ? `${closing.files.join(", ")} have unsaved edits that will be lost.` : "Your edits haven't been saved and will be lost."}
          onClose={ws.cancelClose}
          footer={
            <>
              <Button onClick={ws.cancelClose} data-autofocus>
                Cancel
              </Button>
              <Button variant="danger" onClick={ws.confirmClose}>
                Discard changes
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </Presence>
  );
}
