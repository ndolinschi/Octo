import type { ProjectSession } from "@octo/agent-client";
import { deleteCopy } from "../../lib/sessions/model";
import { ConfirmDelete } from "./parts";
import type { SessionActions } from "./useSessionActions";

/** The one confirmation for deleting a session, from the list's row menu and from the detail's menu. Closes itself when the delete worked. */
export function DeleteSessionDialog(props: { session: ProjectSession; actions: SessionActions; onClose(): void; onDeleted(): void }) {
  const copy = deleteCopy(props.session);
  return (
    <ConfirmDelete
      title={copy.title}
      description={copy.description}
      busy={props.actions.busy === "delete"}
      error={props.actions.error}
      onClose={props.onClose}
      onConfirm={() =>
        void props.actions.remove(props.session.id).then((ok) => {
          if (ok) {
            props.onClose();
            props.onDeleted();
          }
        })
      }
    />
  );
}
