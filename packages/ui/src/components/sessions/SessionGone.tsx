import { useEffect, useState } from "react";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";

/**
 * Decision 96: the route's or the tab's main session no longer exists (deleted, perhaps in another window). Said in place of
 * the conversation, never replaced by another session (the project's gone state, P1-4). Its own chunk: a rare screen.
 */
export function SessionGone(props: { sessionId: string | null; onDefault: (() => void) | undefined }) {
  const { reload } = useProject();
  // A session the list lacks may be one made a moment ago (its event not in yet): the project is read again once before
  // the tab says it is gone (the tab then shows the session when the list has it).
  const [checked, setChecked] = useState<string | null>(null);
  const sid = props.sessionId;
  useEffect(() => {
    if (sid === null || checked === sid) return;
    void reload().finally(() => setChecked(sid));
  }, [sid, checked, reload]);
  if (checked !== sid) return null;
  return (
    <div className="flex h-full min-h-0 flex-col" role="alert" data-session-gone>
      <EmptyState
        title="This session no longer exists"
        actions={
          props.onDefault && (
            <Button size="sm" onClick={props.onDefault}>
              Open the default session
            </Button>
          )
        }
      >
        It was deleted, perhaps in another window.
      </EmptyState>
    </div>
  );
}
