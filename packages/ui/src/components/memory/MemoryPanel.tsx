import { useProject } from "../../state/project";
import { MemoryView, type MemoryTab } from "./MemoryView";

/**
 * The dock's Memory tab: the view for the open project. The dock hands in what only it can do (opening a request in
 * the chat, opening a file); without them the links read as plain text.
 */
export function MemoryPanel(props: {
  onOpenMessage?: (messageId: number) => void;
  onOpenFile?: (path: string) => void;
  initialTab?: MemoryTab;
  turnId?: number;
}) {
  const { projectId } = useProject();
  return <MemoryView projectId={projectId} {...props} />;
}
