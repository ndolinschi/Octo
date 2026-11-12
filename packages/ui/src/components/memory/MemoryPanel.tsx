import { useProject } from "../../state/project";
import { MemoryView, type MemoryTab } from "./MemoryView";

/**
 * The dock's Memory tab: the view for the open project. The dock hands in what only it can do (opening a request in
 * the chat, a file, a note); without them those links read as plain text or are left out.
 */
export function MemoryPanel(props: {
  onOpenMessage?: (messageId: number) => void;
  onOpenFile?: (path: string) => void;
  onOpenNote?: (noteId: string) => void;
  initialView?: MemoryTab;
}) {
  const { projectId } = useProject();
  return <MemoryView projectId={projectId} {...props} />;
}
