import { hrefFor } from "../../lib/route";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";

/** A conversation tab for an agent the project does not have (its own chunk: rare). */
export default function AgentGone({ projectId, projectName }: { projectId: string; projectName: string }) {
  const ws = useOptionalWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EmptyState
        title="Agent not found"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (ws) ws.focusChat();
              else window.location.hash = hrefFor(projectId);
            }}
          >
            Back to session
          </Button>
        }
      >
        This agent isn&apos;t part of {projectName}.
      </EmptyState>
    </div>
  );
}
